# AWS Dev External Secrets

AWS Secrets Manager is the source of truth for AWS Dev runtime secrets. One External Secrets Operator controller reconciles namespace-local `SecretStore` and `ExternalSecret` resources. Each SecretStore assumes a purpose-specific IAM role so namespaces do not share access to each other's AWS secrets.

Terraform manages purpose-specific IAM roles, exact read policies, and Grafana Secret metadata. An operator initializes or rotates the AWS value without writing it to Git or Terraform state. GitOps manages ESO and the Kubernetes Secret projection.

## Grafana break-glass administrator

The AWS secret `dropmong/aws-dev/monitoring/grafana-admin` contains JSON properties named `admin-user` and `admin-password`. Initialize its value only after Terraform creates the secret metadata. Use a protected local input method and suppress AWS CLI output; never place the value in a shell command, committed file, Terraform variable, plan, or CI log.

The Grafana ExternalSecret uses `CreatedOnce` with an immutable, orphaned target because Grafana persists the initial administrator credential in its own database. ESO recreates the Kubernetes Secret if it is deleted, but it does not periodically replace a healthy Secret merely because the AWS value changed.

Changing the AWS value does not rotate an administrator already stored in Grafana's database. A rotation must reset the Grafana account through the Grafana CLI or API, update the AWS value, and deliberately recreate the immutable Kubernetes Secret. Human login should ultimately use OIDC/SSO, leaving this account for emergency access only.

The current self-managed kubeadm cluster does not expose a configured AWS-compatible service-account OIDC issuer. ESO therefore starts from the EC2 node instance profile and assumes the purpose-specific role. The assumed role remains limited to the exact secret ARN; workload-level AWS identity federation is future hardening work.
