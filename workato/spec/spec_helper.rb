require "json"
require "workato-connector-sdk"
require "rspec"
require "vcr"
require "webmock/rspec"

# Every request a spec makes, as the connector sent it. A replayed cassette
# answers with its recorded body, so the request is read here, before VCR
# plays it back.
SENT_REQUESTS = []

VCR.configure do |config|
  config.cassette_library_dir = File.expand_path("../fixtures/vcr_cassettes", __dir__)
  config.hook_into :webmock
  config.default_cassette_options = {
    serialize_with: :json,
    record: :none,
    match_requests_on: %i[method uri]
  }
  config.filter_sensitive_data("<GATEWAY_KEY>") { "Bearer tcgw_test_key" }
  config.before_http_request { |request| SENT_REQUESTS << request }
end

RSpec.configure do |config|
  config.before { SENT_REQUESTS.clear }
  config.around do |example|
    cassette = example.metadata[:cassette]
    cassette ? VCR.use_cassette(cassette) { example.run } : example.run
  end
end
