import * as core from "@actions/core";
import * as github from "@actions/github";

type GitHub = ReturnType<typeof github.getOctokit>;
const prDirtyStatusesOutputKey = `prDirtyStatuses`;
const commonErrorDetailedMessage = `Worflows can't access secrets and have read-only access to upstream when they are triggered by a pull request from a fork, [more information](https://docs.github.com/en/actions/configuring-and-managing-workflows/authenticating-with-the-github_token#permissions-for-the-github_token)`;

async function main() {
	const repoToken = core.getInput("repoToken", { required: true });
	const dirtyLabel = core.getInput("dirtyLabel", { required: true });
	const removeOnDirtyLabel = core.getInput("removeOnDirtyLabel");
	const retryAfter = parseInt(core.getInput("retryAfter") || "120", 10);
	const retryMax = parseInt(core.getInput("retryMax") || "5", 10);

	const client = github.getOctokit(repoToken);

	await checkDirty({
		client,
		dirtyLabel,
		removeOnDirtyLabel,
		after: null,
		retryAfter,
		retryMax,
	});
}

const continueOnMissingPermissions = () =>
	core.getInput("continueOnMissingPermissions") === "true" || false;

const commentOnDirty = () => core.getInput("commentOnDirty");
const commentOnClean = () => core.getInput("commentOnClean");

interface CheckDirtyContext {
	after: string | null;
	client: GitHub;
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
		client,
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
		repository: any;
	}
	const query = `
query openPullRequests($owner: String!, $repo: String!, $after: String) { 
  repository(owner:$owner, name: $repo) { 
    pullRequests(first:100, after:$after, states: OPEN) {
      nodes {
        mergeable
        number
        permalink
        title
        updatedAt
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
	let dirtyComment = commentOnDirty();
	let cleanComment = commentOnClean();
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
				await Promise.all([
					addLabelIfNotExists(dirtyLabel, pullRequest, { client }),
					removeOnDirtyLabel
						? removeLabelIfExists(removeOnDirtyLabel, pullRequest, { client })
						: Promise.resolve(),
					dirtyComment
						? addComment(dirtyComment, pullRequest, { client })
						: Promise.resolve(),
				]);
				dirtyStatuses[pullRequest.number] = true;
				break;
			case "MERGEABLE":
				info(`remove "${dirtyLabel}"`);
				await Promise.all([
					removeLabelIfExists(dirtyLabel, pullRequest, { client }),
					cleanComment
						? addComment(cleanComment, pullRequest, { client })
						: Promise.resolve(),
				]);
				// while we removed a particular label once we enter "CONFLICTING"
				// we don't add it again because we assume that the removeOnDirtyLabel
				// is used to mark a PR as "merge!".
				// So we basically require a manual review pass after rebase.
				dirtyStatuses[pullRequest.number] = false;
				break;
			case "UNKNOWN":
				info(`Retrying after ${retryAfter}s.`);
				await new Promise((resolve) => {
					setTimeout(() => {
						core.info(`retrying with ${retryMax} retries remaining.`);
						resolve(async () => {
							dirtyStatuses = {
								...dirtyStatuses,
								...(await checkDirty({ ...context, retryMax: retryMax - 1 })),
							};
						});
					}, retryAfter * 1000);
				});
				break;
			default:
				throw new TypeError(
					`unhandled mergeable state '${pullRequest.mergeable}'`
				);
		}
	}

	if (pageInfo.hasNextPage) {
		dirtyStatuses = {
			...dirtyStatuses,
			...(await checkDirty({
				...context,
				after: pageInfo.endCursor,
			})),
		};
	} else {
		core.setOutput(prDirtyStatusesOutputKey, dirtyStatuses);
	}
	return dirtyStatuses;
}

/**
 * Assumes that the issue exists
 */
async function addLabelIfNotExists(
	label: string,
	{ number }: { number: number },
	{ client }: { client: GitHub }
) {
	const { data: issue } = await client.issues.get({
		owner: github.context.repo.owner,
		repo: github.context.repo.repo,
		issue_number: number,
	});

	core.debug(JSON.stringify(issue, null, 2));

	const hasLabel =
		issue.labels.find((issueLabel) => {
			return issueLabel.name === label;
		}) !== undefined;

	core.info(`Issue #${number} already has label '${label}'. Skipping.`);

	if (hasLabel) {
		return;
	}

	await client.issues
		.addLabels({
			owner: github.context.repo.owner,
			repo: github.context.repo.repo,
			issue_number: number,
			labels: [label],
		})
		.catch((error) => {
			if (
				(error.status === 403 || error.status === 404) &&
				continueOnMissingPermissions() &&
				error.message.endsWith(`Resource not accessible by integration`)
			) {
				core.warning(
					`could not add label "${label}": ${commonErrorDetailedMessage}`
				);
			} else {
				throw new Error(`error adding "${label}": ${error}`);
			}
		});
}

function removeLabelIfExists(
	label: string,
	{ number }: { number: number },
	{ client }: { client: GitHub }
) {
	return client.issues
		.removeLabel({
			owner: github.context.repo.owner,
			repo: github.context.repo.repo,
			issue_number: number,
			name: label,
		})
		.catch((error) => {
			if (
				(error.status === 403 || error.status === 404) &&
				continueOnMissingPermissions() &&
				error.message.endsWith(`Resource not accessible by integration`)
			) {
				core.warning(
					`could not remove label "${label}": ${commonErrorDetailedMessage}`
				);
			} else if (error.status !== 404) {
				throw new Error(`error removing "${label}": ${error}`);
			} else {
				core.info(
					`On #${number} label "${label}" doesn't need to be removed since it doesn't exist on that issue.`
				);
			}
		});
}

async function addComment(
	comment: string,
	{ number }: { number: number },
	{ client }: { client: GitHub }
): Promise<void> {
	try {
		client.issues.createComment({
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
		} else if (error.status !== 404) {
			throw new Error(`error adding "${comment}": ${error}`);
		}
	}
}
main().catch((error) => {
	core.error(String(error));
	core.setFailed(String(error.message));
});
