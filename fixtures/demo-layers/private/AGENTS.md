# On-prem platform (private cloud, MOCKED demo environment)

Applies only to environments on the private cloud (`env: "private"` in the stack). The environment itself is mocked.

- No data leaves the network: models must run on-prem (vLLM in the onprem cluster), never through an external gateway.
- Store objects only in the on-prem MinIO cluster.
