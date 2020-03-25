import * as core from "@actions/core";
import * as github from "@actions/github";

async function main() {
	const repoToken = core.getInput("repoToken", { required: true });
	const dirtyLabel = core.getInput("dirtyLabel", { required: true });
	const removeOnDirtyLabel = core.getInput("removeOnDirtyLabel", {
		required: true
	});
	const retryAfter = parseInt(core.getInput("retryAfter") || "120", 10);
	const retryMax = parseInt(core.getInput("retryMax") || "5", 10);

	const client = new github.GitHub(repoToken);

	return await checkDirty({
		client,
		dirtyLabel,
		removeOnDirtyLabel,
		after: null,
		retryAfter,
		retryMax
	});
}

interface CheckDirtyContext {
	after: string | null;
	client: github.GitHub;
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
async function checkDirty(context: CheckDirtyContext): Promise<void> {
	const {
		after,
		client,
		dirtyLabel,
		removeOnDirtyLabel,
		retryAfter,
		retryMax
	} = context;

	if (retryMax <= 0) {
		core.warning("reached maximum allowed retries");
		return;
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
		repo: github.context.repo.repo
	});

	const {
		repository: {
			pullRequests: { nodes: pullRequests, pageInfo }
		}
	} = pullsResponse as RepositoryResponse;
	core.debug(JSON.stringify(pullsResponse, null, 2));

	if (pullRequests.length === 0) {
		return;
	}

	for (const pullRequest of pullRequests) {
		core.debug(JSON.stringify(pullRequest, null, 2));

		const info = (message: string) =>
			core.info(`for PR "${pullRequest.title}": ${message}`);

		switch (pullRequest.mergeable) {
			case "CONFLICTING":
				info(`add "${dirtyLabel}", remove "${removeOnDirtyLabel}"`);
				// for labels PRs and issues are the same
				await Promise.all([
					addLabelIfNotExists(dirtyLabel, pullRequest, { client }),
					removeLabelIfExists(removeOnDirtyLabel, pullRequest, { client })
				]);
				break;
			case "MERGEABLE":
				info(`remove "${dirtyLabel}"`);
				await removeLabelIfExists(dirtyLabel, pullRequest, { client });
				// while we removed a particular label once we enter "CONFLICTING"
				// we don't add it again because we assume that the removeOnDirtyLabel
				// is used to mark a PR as "merge!".
				// So we basically require a manual review pass after rebase.
				break;
			case "UNKNOWN":
				info(`Retrying after ${retryAfter}s.`);
				return new Promise(resolve => {
					setTimeout(async () => {
						core.info(`retrying with ${retryMax} retries remaining.`);
						resolve(await checkDirty({ ...context, retryMax: retryMax - 1 }));
					});
				});
				break;
			default:
				throw new TypeError(
					`unhandled mergeable state '${pullRequest.mergeable}'`
				);
		}
	}

	if (pageInfo.hasNextPage) {
		return checkDirty({
			...context,
			after: pageInfo.endCursor
		});
	}
}

/**
 * Assumes that the issue exists
 */
async function addLabelIfNotExists(
	label: string,
	{ number }: { number: number },
	{ client }: { client: github.GitHub }
) {
	const { data: issue } = await client.issues.get({
		owner: github.context.repo.owner,
		repo: github.context.repo.repo,
		issue_number: number
	});

	core.debug(JSON.stringify(issue, null, 2));

	const hasLabel =
		issue.labels.find(issueLabel => {
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
			labels: [label]
		})
		.catch(error => {
			throw new Error(`error adding "${label}": ${error}`);
		});
}

function removeLabelIfExists(
	label: string,
	{ number }: { number: number },
	{ client }: { client: github.GitHub }
) {
	return client.issues
		.removeLabel({
			owner: github.context.repo.owner,
			repo: github.context.repo.repo,
			issue_number: number,
			name: label
		})
		.catch(error => {
			if (error.status !== 404) {
				throw new Error(`error removing "${label}": ${error}`);
			} else {
				core.info(
					`On #${number} label "${label}" doesn't need to be removed since it doesn't exist on that issue.`
				);
			}
		});
}

main().catch(error => {
	core.error(String(error));
	core.setFailed(String(error.message));
});
