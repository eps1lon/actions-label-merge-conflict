# Changelog

## unreleased

- Only update PRs based off of the branch in the `push` event
  Previously we checked every open PR.
  Since a `push` to a branch can only create merge conflicts with that branch we can limit the set of checked PRs.
  This should help repositories with lots of PRs targetting different branches with rate limiting.

## 1.4.0

- Allow warning only if secrets aren't available ([#22](https://github.com/eps1lon/actions-label-merge-conflict/pull/22) by @baywet)
- Remove requirement for removeOnDirtyLabel ([#21](https://github.com/eps1lon/actions-label-merge-conflict/pull/21) by @baywet)

## 1.3.0

- set PRs and their dirty state as output ([#17](https://github.com/eps1lon/actions-label-merge-conflict/pull/17) by @baywet)
