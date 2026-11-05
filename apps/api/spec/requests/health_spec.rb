# frozen_string_literal: true

require "rails_helper"

RSpec.describe "Health check", type: :request do
  describe "GET /api/v1/health" do
    context "when the client sends no headers or cookies" do
      it "returns the health status as defined by the API contract", :aggregate_failures do
        get "/api/v1/health"

        expect(response).to have_http_status(:ok)
        expect(response.media_type).to eq("application/json")
        expect(response.parsed_body).to eq("status" => "ok")
        expect(response).to match_api_contract
      end
    end
  end

  describe "GET /up" do
    context "when the application boots" do
      it "returns 200 so containers and load balancers can treat it as live" do
        get "/up"

        expect(response).to have_http_status(:ok)
      end
    end
  end
end
