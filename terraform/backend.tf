terraform {
  /**
   * Remote state on an S3-compatible backend (MinIO, see bootstrap/).
   *
   * Why not local state: a terraform.tfstate on one laptop cannot be shared
   * with CI or a second engineer, has no locking, and is gone with the disk.
   * State also contains every attribute Terraform read - treat it as sensitive.
   *
   * `use_lockfile = true` uses S3's native conditional-write locking
   * (Terraform >= 1.10), which replaces the old DynamoDB table. Without a lock,
   * two concurrent applies can interleave writes and corrupt state.
   *
   * Credentials are NOT here. Supply them as environment variables:
   *   $env:AWS_ACCESS_KEY_ID     = "courtsplit"
   *   $env:AWS_SECRET_ACCESS_KEY = "courtsplit-dev-secret"
   *
   * Pointing this at real AWS S3 means deleting the `endpoints`,
   * `use_path_style` and the skip_* flags, and setting a real region. Nothing
   * else changes.
   */
  backend "s3" {
    bucket = "courtsplit-tfstate"
    key    = "courtsplit/kind/terraform.tfstate"
    region = "us-east-1"

    endpoints = {
      s3 = "http://localhost:9000"
    }

    # MinIO serves buckets as a path, not a subdomain.
    use_path_style = true
    # Native S3 state locking; no DynamoDB table required.
    use_lockfile = true

    # These skips exist because MinIO is not AWS: there is no STS to validate
    # credentials against, no EC2 metadata endpoint, and no account id.
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
  }
}
