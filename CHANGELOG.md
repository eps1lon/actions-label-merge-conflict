# Changelog

## 2.1.0

- Address set-output deprecation ([#92](https://github.com/eps1lon/actions-label-merge-conflict/pull/92) by @NotMyFault)
- Fix CVE-2022-35954 ([#92](https://github.com/eps1lon/actions-label-merge-conflict/pull/92) by @NotMyFault)

## 2.0.1

- Improve retry logic ([#31](https://github.com/eps1lon/actions-label-merge-conflict/pull/31) by @eps1lon)

## 2.0.0

- Only update PRs based off of the branch in the `push` event
  Previously we checked every open PR.
  Since a `push` to a branch can only create merge conflicts with that branch we can limit the set of checked PRs.
  This should help repositories with lots of PRs targetting different branches with rate limiting.
- Only leave comments if the `dirtyLabel` was added or removed

## 1.4.0

- Allow warning only if secrets aren't available ([#22](https://github.com/eps1lon/actions-label-merge-conflict/pull/22) by @baywet)
- Remove requirement for removeOnDirtyLabel ([#21](https://github.com/eps1lon/actions-label-merge-conflict/pull/21) by @baywet)

## 1.3.0

- set PRs and their dirty state as output ([#17](https://github.com/eps1lon/actions-label-merge-conflict/pull/17) by @baywet)
