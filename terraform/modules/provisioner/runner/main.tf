# ---------------------------------------------------------------------------
# Runner root — instantiates the golden-bucket module for a single request.
# The CodeBuild runner `cd`s here, drops terraform.auto.tfvars.json, and runs
# init/plan/apply under the per-request ABAC session of the provisioning role.
# ---------------------------------------------------------------------------

module "golden_bucket" {
  source = "../../golden-bucket"

  bucket_name        = var.bucket_name
  team               = var.team
  owner              = var.owner
  cost_center        = var.cost_center
  path               = var.path
  trusted_principals = var.trusted_principals
}
