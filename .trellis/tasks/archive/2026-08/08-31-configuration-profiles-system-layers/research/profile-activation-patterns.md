# Profile Activation Pattern Research

## Comparable Patterns

### Codex profile-v2

Codex uses an explicit launch selector and a separate sparse profile file. Selection is outside the
configuration merge, which makes loading deterministic, but selection is not durable by itself.

### Google Cloud CLI named configurations

The gcloud CLI keeps named configurations separately and persists which configuration is active.
Activation state is control-plane state rather than a property inside the selected configuration.
This supports a durable `use`-style command without recursive configuration loading.

Reference: <https://cloud.google.com/sdk/docs/configurations>

### AWS CLI named profiles

AWS keeps named profiles in shared config/credential files and selects them per invocation through
`--profile` or `AWS_PROFILE`. This is deterministic and automation-friendly, but there is no
canonical durable active profile for an interactive product to display.

Reference: <https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-profiles.html>

### Kubernetes contexts

Kubeconfig stores `current-context` inside the same aggregate document as contexts. It offers a
convenient durable switch, but selection and payload share a mutation boundary and merge behavior
becomes more complex when multiple kubeconfig files participate.

Reference: <https://kubernetes.io/docs/concepts/configuration/organize-cluster-access-kubeconfig/>

## Feasible mycli Approaches

### A. Dedicated activation state (recommended)

Store versioned activation metadata in `~/.mycli/profile-state.json`; keep profile payloads in
`~/.mycli/profiles/<name>.toml`. The loader reads activation once, validates the name, then loads the
selected sparse layer. A future launch-only `--profile` can override activation without changing it.

This cleanly separates control state from configuration, avoids recursion, and gives `profile use`
one atomic file to mutate. It adds one small state format.

### B. Active name in base user TOML

Store an `active_profile` key in `~/.mycli/config.toml`, bootstrap-read it, then load and merge the
profile. Profile/system schemas must forbid that key, and every resolver needs a two-stage parse.

This avoids a new file but mixes loader control with effective settings, complicates validation,
and creates legacy/migration pressure similar to the conflict Codex explicitly rejects.

### C. Launch-only selector

Support only `--profile` / `MYCLI_PROFILE`, like AWS/Codex invocation selection, and omit durable
`profile use` state.

This is the smallest loader contract but does not meet the planned interactive `profile use` UX.

## Recommendation

Use approach A. Treat the selected name as startup state, not a configuration leaf; fail clearly if
the selected file is missing or invalid; and make `profile use` affect subsequent process starts,
not mutate an already running runtime snapshot.

