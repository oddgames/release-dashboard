# Fastlane helper to update the build dashboard
# Add to your Fastfile: import "./dashboard_helper.rb"

require 'net/http'
require 'json'
require 'uri'

DASHBOARD_URL = ENV['DASHBOARD_URL'] || 'http://localhost:3000'

# Update store status on the dashboard
#
# @param job_name [String] The job identifier (e.g., "MyApp-iOS")
# @param branch [String] The branch name (e.g., "main")
# @param store [String] "googlePlay" or "appStore"
# @param status [String] "uploaded", "in_review", "live", "rejected"
# @param track [String] The release track (e.g., "production", "beta", "alpha", "internal", "testflight")
# @param review_status [String] Optional: "pending", "in_review", "approved", "rejected"
# @param download_url [String] Optional: Direct download URL for the build
#
def update_dashboard(job_name:, branch:, store:, status:, track: nil, review_status: nil, download_url: nil)
  uri = URI.parse("#{DASHBOARD_URL}/api/store-status")

  payload = {
    jobName: job_name,
    branch: branch,
    store: store,
    status: status,
    track: track,
    reviewStatus: review_status,
    downloadUrl: download_url
  }.compact

  begin
    http = Net::HTTP.new(uri.host, uri.port)
    http.use_ssl = uri.scheme == 'https'

    request = Net::HTTP::Post.new(uri.path)
    request['Content-Type'] = 'application/json'
    request.body = payload.to_json

    response = http.request(request)

    if response.code.to_i == 200
      UI.success("Dashboard updated: #{store} - #{status}")
    else
      UI.error("Failed to update dashboard: #{response.code} - #{response.body}")
    end
  rescue => e
    UI.error("Dashboard update error: #{e.message}")
  end
end

# Convenience methods for common scenarios

def dashboard_uploaded_to_play_store(job_name:, branch:, track:)
  update_dashboard(
    job_name: job_name,
    branch: branch,
    store: 'googlePlay',
    status: 'uploaded',
    track: track
  )
end

def dashboard_uploaded_to_app_store(job_name:, branch:, track: 'testflight')
  update_dashboard(
    job_name: job_name,
    branch: branch,
    store: 'appStore',
    status: 'uploaded',
    track: track
  )
end

def dashboard_in_review(job_name:, branch:, store:)
  update_dashboard(
    job_name: job_name,
    branch: branch,
    store: store,
    status: 'in_review',
    review_status: 'in_review'
  )
end

def dashboard_live(job_name:, branch:, store:, track:)
  update_dashboard(
    job_name: job_name,
    branch: branch,
    store: store,
    status: 'live',
    track: track
  )
end
