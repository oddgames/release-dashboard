// Paste this script into Jenkins Script Console
// Manage Jenkins > Script Console
//
// This will output the credential contents that you can copy

import com.cloudbees.plugins.credentials.CredentialsProvider
import org.jenkinsci.plugins.plaincredentials.FileCredentials
import org.jenkinsci.plugins.plaincredentials.StringCredentials

println "=" * 60
println "FASTLANE CREDENTIALS EXPORT"
println "=" * 60
println ""

// Get all file credentials
def fileCreds = CredentialsProvider.lookupCredentials(
    FileCredentials.class,
    Jenkins.instance,
    null,
    null
)

// Get all string credentials
def stringCreds = CredentialsProvider.lookupCredentials(
    StringCredentials.class,
    Jenkins.instance,
    null,
    null
)

// Export Apple API Key
println "--- APPLE API KEY (apple_api_key) ---"
def appleKey = fileCreds.find { it.id == 'apple_api_key' }
if (appleKey) {
    println appleKey.content.text
} else {
    println "NOT FOUND"
}
println ""

// Export Google Play JSON
println "--- GOOGLE PLAY JSON (google_play_json) ---"
def playKey = fileCreds.find { it.id == 'google_play_json' }
if (playKey) {
    println playKey.content.text
} else {
    println "NOT FOUND"
}
println ""

println "=" * 60
println "Copy each section above to the corresponding file:"
println "  apple_api_key -> fastlane/apple_api_key.json"
println "  google_play_json -> fastlane/google_play_key.json"
println "=" * 60
