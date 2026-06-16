# AWS dev data NetworkPolicy

AWS dev already has DB and Kafka runtime resources, but those resources are not adopted by a `platform/data` Argo CD Application.

This path manages only data-layer NetworkPolicy resources for AWS dev. It intentionally does not include the DB, Kafka, or pgAdmin StatefulSet/Deployment manifests from `platform/data`.

Keep the policy model aligned with `platform/data/networkpolicies.yaml` and `platform/data-private-dev/networkpolicies.yaml`.
