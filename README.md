# label merge-conflict action

This action adds a given label to Pull Requests that have merge conflicts and removes a given label from these pull requests

![label lifecycle: open (no label), push to master -> merge conflict -> label: PR needs rebase -> resolve conflicts on PR -> remove label: PR needs rebase](https://raw.githubusercontent.com/eps1lon/actions-label-merge-conflict/docs/rationale/label-lifecycle.png).

## Why?

PRs are usually open for a few days until a maintainer can take a look. When this happens a Pull Request (PR) might already be outdated without the author being notified of this. A maintainer either has to resolve them (which takes time) or has to ping the author. This creates a feedback loop that can be reduce by notifying the author as soon as a PR has merge conflicts.

This actions achieve this with minimal noise (no comment bloat) by adding a label to a PR if it has merge conflicts. This triggers a "state change" notification in GitHub and the author can resolve the conflicts before the maintainer looked at a PR. At the same time the maintainer has a simple filter out PRs that have merge conflicts.

## Inputs

### `dirtyLabel`

**Required** The name of the label that should be added once a PR has merge conflicts.

### `removeOnDirtyLabel`

**Required** The name of the label that should be removed once a PR has merge conflicts.

### `repoToken`

**Required** Token for the repository. Can be passed in using {{ secrets.GITHUB_TOKEN }}

## Example usage

```yaml
name: "Maintenance"
on:
  # So that PRs touching the same files as the push are updated
  push:
  # So that the `dirtyLabel` is removed if conflicts are resolved
  pull_request:
    types: [synchronize]

jobs:
  main:
    runs-on: ubuntu-latest
    steps:
      - name: check if prs are dirty
        uses: eps1lon/actions-label-merge-conflict@releases/1.x
        with:
          dirtyLabel: "PR: needs rebase"
          removeOnDirtyLabel: "PR: ready to ship"
          repoToken: "${{ secrets.GITHUB_TOKEN }}"
```
