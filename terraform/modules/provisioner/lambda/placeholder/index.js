// Placeholder handler for terraform plan/validate only.
// The real implementation is compiled from src/provisioner-glue and injected at
// deploy time via var.lambda_source_dir. Do not add logic here.
exports.handler = async () => {
  throw new Error(
    "provisioner-glue placeholder invoked: deploy the compiled src/provisioner-glue bundle via var.lambda_source_dir",
  );
};
