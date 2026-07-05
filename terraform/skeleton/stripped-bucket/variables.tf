variable "request_id" {
  description = "The provision requestId — used as a bucket name suffix and resource tag."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", var.request_id))
    error_message = "request_id must be a lowercase UUID (8-4-4-4-12 hex groups)."
  }
}

variable "correlation_id" {
  description = "Correlation-id from the originating API request — carried as a resource tag."
  type        = string
  default     = ""
}

variable "aws_region" {
  description = "AWS region for the stripped bucket."
  type        = string
  default     = "us-east-1"
}
