import * as core from "@actions/core";
import * as github from "@actions/github";

type GitHub = ReturnType<typeof github.getOctokit>;
const prDirtyStatusesOutputKey = `prDirtyStatuses`;
const commonErrorDetailedMessage = `Worflows can't access secrets and have read-only access to upstream when they are triggered by a pull request from a fork, [more information](https://docs.github.com/en/actions/configuring-and-managing-workflows/authenticating-with-the-github_token#permissions-for-the-github_token)`;

/**
 * returns `null` if the ref isn't a branch but e.g. a tag
 * @param ref
 */
function getBranchName(ref: string): string | null {
	if (ref.startsWith("refs/heads/")) {
		return ref.replace(/^refs\/heads\//, "");
	}
	return null;
}

async function main() {
	const repoToken = core.getInput("repoToken", { required: true });
	const dirtyLabel = core.getInput("dirtyLabel", { required: true });
	const removeOnDirtyLabel = core.getInput("removeOnDirtyLabel");
	const retryAfter = parseInt(core.getInput("retryAfter") || "120", 10);
	const retryMax = parseInt(core.getInput("retryMax") || "5", 10);
	const commentOnDirty = core.getInput("commentOnDirty");
	const commentOnClean = core.getInput("commentOnClean");

	const isPushEvent = process.env.GITHUB_EVENT_NAME === "push";
	core.debug(`isPushEvent = ${process.env.GITHUB_EVENT_NAME} === "push"`);
	const baseRefName = isPushEvent ? getBranchName(github.context.ref) : null;

	const client = github.getOctokit(repoToken);

	const dirtyStatuses = await checkDirty({
		baseRefName,
		client,
		commentOnClean,
		commentOnDirty,
		dirtyLabel,
		removeOnDirtyLabel,
		after: null,
		retryAfter,
		retryMax,
	});

	core.setOutput(prDirtyStatusesOutputKey, dirtyStatuses);
}

const continueOnMissingPermissions = () =>
	core.getInput("continueOnMissingPermissions") === "true" || false;

interface CheckDirtyContext {
	after: string | null;
	baseRefName: string | null;
	client: GitHub;
	commentOnClean: string;
	commentOnDirty: string;
	dirtyLabel: string;
	removeOnDirtyLabel: string;
	/**
	 * number of seconds after which the mergable state is re-checked
	 * if it is unknown
	 */
	retryAfter: number;
	// number of allowed retries
	retryMax: number;
}
async function checkDirty(
	context: CheckDirtyContext
): Promise<Record<number, boolean>> {
	const {
		after,
		baseRefName,
		client,
		commentOnClean,
		commentOnDirty,
		dirtyLabel,
		removeOnDirtyLabel,
		retryAfter,
		retryMax,
	} = context;

	if (retryMax <= 0) {
		core.warning("reached maximum allowed retries");
		return {};
	}

	interface RepositoryResponse {
		repository: {
			pullRequests: {
				nodes: Array<{
					mergeable: string;
					number: number;
					permalink: string;
					title: string;
					updatedAt: string;
					labels: {
						nodes: Array<{ name: string }>;
					};
				}>;
				pageInfo: {
					endCursor: string;
					hasNextPage: boolean;
				};
			};
		};
	}
	const query = `
query openPullRequests($owner: String!, $repo: String!, $after: String, $baseRefName: String) { 
  repository(owner:$owner, name: $repo) { 
    pullRequests(first: 100, after: $after, states: OPEN, baseRefName: $baseRefName) {
      nodes {
        mergeable
        number
        permalink
        title
        updatedAt
        labels(first: 100) {
          nodes {
            name
          }
        }
      }
      pageInfo {
        endCursor
        hasNextPage
      }
    }
  }
}
  `;
	core.debug(query);
	const pullsResponse = await client.graphql(query, {
		headers: {
			// merge-info preview causes mergeable to become "UNKNOW" (from "CONFLICTING")
			// kind of obvious to no rely on experimental features but...yeah
			//accept: "application/vnd.github.merge-info-preview+json"
		},
		after,
		baseRefName,
		owner: github.context.repo.owner,
		repo: github.context.repo.repo,
	});

	const {
		repository: {
			pullRequests: { nodes: pullRequests, pageInfo },
		},
	} = pullsResponse as RepositoryResponse;
	core.debug(JSON.stringify(pullsResponse, null, 2));

	if (pullRequests.length === 0) {
		return {};
	}
	let dirtyStatuses: Record<number, boolean> = {};
	for (const pullRequest of pullRequests) {
		core.debug(JSON.stringify(pullRequest, null, 2));

		const info = (message: string) =>
			core.info(`for PR "${pullRequest.title}": ${message}`);

		switch (pullRequest.mergeable) {
			case "CONFLICTING":
				info(
					`add "${dirtyLabel}", remove "${
						removeOnDirtyLabel ? removeOnDirtyLabel : `nothing`
					}"`
				);
				// for labels PRs and issues are the same
				const [addedDirtyLabel] = await Promise.all([
					addLabelIfNotExists(dirtyLabel, pullRequest, { client }),
					removeOnDirtyLabel
						? removeLabelIfExists(removeOnDirtyLabel, pullRequest, { client })
						: Promise.resolve(false),
				]);
				if (commentOnDirty !== "" && addedDirtyLabel) {
					await addComment(commentOnDirty, pullRequest, { client });
				}
				dirtyStatuses[pullRequest.number] = true;
				break;
			case "MERGEABLE":
				info(`remove "${dirtyLabel}"`);
				const removedDirtyLabel = await removeLabelIfExists(
					dirtyLabel,
					pullRequest,
					{ client }
				);
				if (removedDirtyLabel && commentOnClean !== "") {
					await addComment(commentOnClean, pullRequest, { client });
				}
				// while we removed a particular label once we enter "CONFLICTING"
				// we don't add it again because we assume that the removeOnDirtyLabel
				// is used to mark a PR as "merge!".
				// So we basically require a manual review pass after rebase.
				dirtyStatuses[pullRequest.number] = false;
				break;
			case "UNKNOWN":
				info(`Retrying after ${retryAfter}s.`);
				return new Promise((resolve) => {
					setTimeout(() => {
						core.info(`retrying with ${retryMax} retries remaining.`);

						checkDirty({ ...context, retryMax: retryMax - 1 }).then(
							(newDirtyStatuses) => {
								resolve({
									...dirtyStatuses,
									...newDirtyStatuses,
								});
							}
						);
					}, retryAfter * 1000);
				});
			default:
				throw new TypeError(
					`unhandled mergeable state '${pullRequest.mergeable}'`
				);
		}
	}

	if (pageInfo.hasNextPage) {
		return {
			...dirtyStatuses,
			...(await checkDirty({
				...context,
				after: pageInfo.endCursor,
			})),
		};
	}
	return dirtyStatuses;
}

/**
 * Assumes that the label exists
 * @returns `true` if the label was added, `false` otherwise (e.g. when it already exists)
 */
async function addLabelIfNotExists(
	labelName: string,
	issue: { number: number; labels: { nodes: Array<{ name: string }> } },
	{ client }: { client: GitHub }
): Promise<boolean> {
	core.debug(JSON.stringify(issue, null, 2));

	const hasLabel =
		issue.labels.nodes.find((labe) => {
			return labe.name === labelName;
		}) !== undefined;

	if (hasLabel) {
		core.info(
			`Issue #${issue.number} already has label '${labelName}'. No need to add.`
		);
		return false;
	}

	return await client.rest.issues
		.addLabels({
			owner: github.context.repo.owner,
			repo: github.context.repo.repo,
			issue_number: issue.number,
			labels: [labelName],
		})
		.then(
			() => true,
			(error) => {
				if (
					(error.status === 403 || error.status === 404) &&
					continueOnMissingPermissions() &&
					error.message.endsWith(`Resource not accessible by integration`)
				) {
					core.warning(
						`could not add label "${labelName}": ${commonErrorDetailedMessage}`
					);
				} else {
					throw new Error(`error adding "${labelName}": ${error}`);
				}
				return false;
			}
		);
}

async function removeLabelIfExists(
	labelName: string,
	issue: { number: number; labels: { nodes: Array<{ name: string }> } },
	{ client }: { client: GitHub }
): Promise<boolean> {
	const hasLabel =
		issue.labels.nodes.find((labe) => {
			return labe.name === labelName;
		}) !== undefined;
	if (!hasLabel) {
		core.info(
			`Issue #${issue.number} does not have label '${labelName}'. No need to remove.`
		);
		return false;
	}

	return client.rest.issues
		.removeLabel({
			owner: github.context.repo.owner,
			repo: github.context.repo.repo,
			issue_number: issue.number,
			name: labelName,
		})
		.then(
			() => true,
			(error) => {
				if (
					(error.status === 403 || error.status === 404) &&
					continueOnMissingPermissions() &&
					error.message.endsWith(`Resource not accessible by integration`)
				) {
					core.warning(
						`could not remove label "${labelName}": ${commonErrorDetailedMessage}`
					);
				} else if (error.status !== 404) {
					throw new Error(`error removing "${labelName}": ${error}`);
				} else {
					core.info(
						`On #${issue.number} label "${labelName}" doesn't need to be removed since it doesn't exist on that issue.`
					);
				}
				return false;
			}
		);
}

async function addComment(
	comment: string,
	{ number }: { number: number },
	{ client }: { client: GitHub }
): Promise<void> {
	try {
		await client.rest.issues.createComment({
			owner: github.context.repo.owner,
			repo: github.context.repo.repo,
			issue_number: number,
			body: comment,
		});
	} catch (error) {
		if (
			(error.status === 403 || error.status === 404) &&
			continueOnMissingPermissions() &&
			error.message.endsWith(`Resource not accessible by integration`)
		) {
			core.warning(
				`couldn't add comment "${comment}": ${commonErrorDetailedMessage}`
			);
		} else {
			throw new Error(`error adding "${comment}": ${error}`);
		}
	}
}
main().catch((error) => {
	core.error(String(error));
	core.setFailed(String(error.message));
});
