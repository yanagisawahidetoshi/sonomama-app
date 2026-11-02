# frozen_string_literal: true

module Api
  module V1
    class HealthController < ApplicationController
      def show
        render json: { status: "ok" }
      end
    end
  end
end
