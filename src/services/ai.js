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
  const modelName = config.ai?.model || 'gemini-3-pro-latest';

  log.info('server', 'Generating release notes with AI', { projectName, model: modelName });

  const prompt = `You are a mobile game release notes writer. Generate player-friendly release notes for "${projectName}" based on these development commits:

${commitMessages}

Guidelines:
- Write for players, not developers - focus on what they'll experience
- Group changes into categories like "New Features", "Improvements", "Bug Fixes" where applicable
- Keep it concise and engaging
- Do NOT use emojis
- Avoid technical jargon (no mentions of "refactoring", "API", "SDK", etc.)
- If commits are mostly internal changes, summarize as general improvements
- Maximum 200 words

Format the output as plain text suitable for app store release notes.`;

  try {
    const model = genAI.getGenerativeModel({ model: modelName });
    const result = await model.generateContent(prompt);
    const englishNotes = result.response.text();

    // Generate translations for all languages
    const translations = await translateReleaseNotes(englishNotes, languages);

    return translations;
  } catch (error) {
    log.error('server', 'AI generation failed', { error: error.message });
    throw new Error(`AI generation failed: ${error.message}`);
  }
}

// AI helper: Translate release notes to multiple languages
async function translateReleaseNotes(englishNotes, languages) {
  const modelName = config.ai?.model || 'gemini-3-pro-latest';
  const translations = { en: englishNotes };

  // Get languages that need translation (exclude English)
  const targetLanguages = languages.filter(lang => lang !== 'en');

  if (targetLanguages.length === 0) {
    return translations;
  }

  log.info('server', 'Translating release notes', { targetLanguages });

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

  const prompt = `Translate these mobile game release notes to the following languages. Maintain the same tone and formatting.

Original English:
${englishNotes}

Translate to: ${targetLanguages.map(lang => `${languageNames[lang] || lang} (${lang})`).join(', ')}

Output format - provide each translation clearly labeled:
[LANG_CODE]
translated text here

For example:
[de]
German text here

[fr]
French text here`;

  try {
    const model = genAI.getGenerativeModel({ model: modelName });
    const result = await model.generateContent(prompt);
    const responseText = result.response.text();

    // Parse translations from response
    for (const lang of targetLanguages) {
      const regex = new RegExp(`\\[${lang}\\]\\s*([\\s\\S]*?)(?=\\[\\w|$)`, 'i');
      const match = responseText.match(regex);
      if (match) {
        translations[lang] = match[1].trim();
      }
    }

    return translations;
  } catch (error) {
    log.error('server', 'Translation failed', { error: error.message });
    // Return just English if translation fails
    return translations;
  }
}

module.exports = {
  genAI,
  generateComparisonSummary,
  generateReleaseNotes,
  translateReleaseNotes
};
