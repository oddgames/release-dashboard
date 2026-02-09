const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('../config');
const log = require('../logger');

// Initialize Gemini client if API key is configured
const genAI = config.ai?.apiKey ? new GoogleGenerativeAI(config.ai.apiKey) : null;

// AI helper: Generate comparison summary from changesets and merges
async function generateComparisonSummary(projectName, changesets, merges, fileDiff) {
  const modelName = config.ai?.model || 'gemini-2.0-flash';

  log.info('server', 'Generating comparison summary with AI', { projectName, model: modelName, changesetCount: changesets.length });

  // Send all commits - just messages
  const commitList = changesets.map(c => `- ${c.message}`).join('\n');

  const prompt = `Summarize these ${changesets.length} commits for "${projectName}" mobile game.

Commits:
${commitList}

Output format (use these exact headers in this order):
## Fixes
## New Features
## Internal

Rules:
- Fixes & New Features: Write like app store release notes - friendly, player-focused, no technical jargon
- Internal: Technical and concise (for developers)
- Merge duplicate/related changes into single bullet points
- Skip trivial changes (typos, formatting, minor tweaks)
- Order by user impact within each category
- Use markdown bullet points (- item)
- No preamble - start directly with ## Fixes
- No emojis`;

  try {
    const model = genAI.getGenerativeModel({ model: modelName });
    const result = await model.generateContent(prompt);
    return result.response.text();
  } catch (error) {
    log.error('server', 'AI comparison summary failed', { error: error.message });
    throw error;
  }
}

// AI helper: Generate release notes from commit messages
async function generateReleaseNotes(projectName, commitMessages, languages) {
  // Use Gemini 3 Pro Preview for high-quality English generation
  const modelName = config.ai?.model || 'gemini-3-pro-preview';

  log.info('server', 'Generating release notes with AI', { projectName, model: modelName });

  const prompt = `Write concise app store release notes for "${projectName}" based on these commits:

${commitMessages}

Format:
NEW
- Feature 1
- Feature 2

FIXED
- Bug fix 1
- Bug fix 2

Rules:
- Start DIRECTLY with NEW or FIXED - no preamble, no intro text, no "Here are..."
- Be direct and factual, no marketing fluff or hype
- No emojis, no exclamation marks
- Skip internal/technical changes unless user-facing
- Target 400-500 characters total (app store limit is 500)
- Keep bullet points short but PRESERVE SPECIFIC NAMES (truck names, level names, character names, item names, etc.)
- Example: "New trucks: Grave Digger, El Toro Loco" NOT "New monster trucks added"
- Group related items: "New trucks: X, Y, Z" instead of separate bullets for each
- If no new features, omit NEW section
- If no bug fixes, omit FIXED section`;

  try {
    const model = genAI.getGenerativeModel({ model: modelName });

    // Get target languages (exclude English)
    const targetLanguages = languages.filter(lang => lang !== 'en');

    // Generate English with timeout and retry
    const englishStart = Date.now();
    log.info('server', 'Starting English generation...');

    let englishNotes;
    let lastError;
    const maxRetries = 2;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        log.info('server', `Generation attempt ${attempt}/${maxRetries}`);

        // Create a timeout promise (60 seconds)
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('AI generation timed out after 60 seconds')), 60000);
        });

        // Race between generation and timeout
        const englishResult = await Promise.race([
          model.generateContent(prompt),
          timeoutPromise
        ]);

        englishNotes = englishResult.response.text();
        log.info('server', `English generation done in ${Date.now() - englishStart}ms`);
        break; // Success, exit retry loop
      } catch (error) {
        lastError = error;
        log.warn('server', `Attempt ${attempt} failed: ${error.message}`);

        if (attempt < maxRetries) {
          log.info('server', 'Retrying in 2 seconds...');
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
    }

    if (!englishNotes) {
      throw lastError || new Error('Failed to generate release notes after retries');
    }

    // If no other languages, return just English
    if (targetLanguages.length === 0) {
      return { en: englishNotes };
    }

    // Translate in parallel with Flash model (silent)
    const translations = await translateReleaseNotes(englishNotes, languages);
    return translations;
  } catch (error) {
    log.error('server', 'AI generation failed', { error: error.message, stack: error.stack });
    throw new Error(`AI generation failed: ${error.message}`);
  }
}

// AI helper: Translate release notes to multiple languages
async function translateReleaseNotes(englishNotes, languages) {
  // Use Gemini 2.5 Flash for fast translations
  const modelName = 'gemini-2.5-flash';
  const translations = { en: englishNotes };

  // Get languages that need translation (exclude English)
  const targetLanguages = languages.filter(lang => lang !== 'en');

  if (targetLanguages.length === 0) {
    return translations;
  }

  const languageNames = {
    'de': 'German',
    'fr': 'French',
    'es': 'Spanish',
    'it': 'Italian',
    'pt': 'Portuguese (Brazilian)',
    'ru': 'Russian',
    'ja': 'Japanese',
    'ko': 'Korean',
    'zh-Hans': 'Simplified Chinese',
    'zh-Hant': 'Traditional Chinese',
    'ar': 'Arabic',
    'nl': 'Dutch',
    'pl': 'Polish',
    'tr': 'Turkish',
    'th': 'Thai',
    'vi': 'Vietnamese',
    'id': 'Indonesian'
  };

  // Split languages into batches for parallel translation
  const batchSize = 4;
  const batches = [];
  for (let i = 0; i < targetLanguages.length; i += batchSize) {
    batches.push(targetLanguages.slice(i, i + batchSize));
  }

  log.debug('server', 'Translating release notes', { languages: targetLanguages.length });

  const model = genAI.getGenerativeModel({ model: modelName });

  // Run all batches in parallel
  const batchPromises = batches.map(async (batchLangs) => {
    const prompt = `Translate these release notes. Keep same format.

English:
${englishNotes}

Translate to: ${batchLangs.map(lang => `${languageNames[lang] || lang} (${lang})`).join(', ')}

Output format:
[LANG_CODE]
translated text

Example:
[de]
German text here`;

    const result = await model.generateContent(prompt);
    return result.response.text();
  });

  try {
    const batchResults = await Promise.all(batchPromises);

    // Parse all batch results
    for (const responseText of batchResults) {
      for (const lang of targetLanguages) {
        if (translations[lang]) continue; // Already have this one
        const regex = new RegExp(`\\[${lang}\\]\\s*([\\s\\S]*?)(?=\\[\\w|$)`, 'i');
        const match = responseText.match(regex);
        if (match) {
          translations[lang] = match[1].trim();
        }
      }
    }

    return translations;
  } catch (error) {
    log.error('server', 'Translation failed', { error: error.message });
    // Return just English if translation fails
    return translations;
  }
}

// Streaming version of release notes generation
async function* streamReleaseNotes(projectName, commitMessages) {
  const modelName = config.ai?.model || 'gemini-2.0-flash';

  log.info('server', 'Streaming release notes with AI', { projectName, model: modelName });

  const prompt = `Write concise app store release notes for "${projectName}" based on these commits:

${commitMessages}

Format:
NEW
- Feature 1
- Feature 2

FIXED
- Bug fix 1
- Bug fix 2

Rules:
- Start DIRECTLY with NEW or FIXED - no preamble, no intro text, no "Here are..."
- Be direct and factual, no marketing fluff or hype
- No emojis, no exclamation marks
- Skip internal/technical changes unless user-facing
- Target 400-500 characters total (app store limit is 500)
- Keep bullet points short but PRESERVE SPECIFIC NAMES (truck names, level names, character names, item names, etc.)
- Example: "New trucks: Grave Digger, El Toro Loco" NOT "New monster trucks added"
- Group related items: "New trucks: X, Y, Z" instead of separate bullets for each
- If no new features, omit NEW section
- If no bug fixes, omit FIXED section`;

  const model = genAI.getGenerativeModel({ model: modelName });
  const result = await model.generateContentStream(prompt);

  for await (const chunk of result.stream) {
    const text = chunk.text();
    if (text) {
      yield text;
    }
  }
}

module.exports = {
  genAI,
  generateComparisonSummary,
  generateReleaseNotes,
  translateReleaseNotes,
  streamReleaseNotes
};
