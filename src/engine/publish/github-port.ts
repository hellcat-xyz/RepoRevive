import type { TreeEntry } from './changes';

export interface RepoInfo {
  owner: string;
  name: string;
  defaultBranch: string;
  isPrivate: boolean;
  archived: boolean;
  disabled: boolean;
  fork: boolean;
  parent: { owner: string; name: string } | null;
  /** The authenticated user's effective permissions on this repository. */
  permissions: { push: boolean; pull: boolean; admin: boolean };
}

export interface CommitInfo {
  sha: string;
  treeSha: string;
  parents: string[];
  message: string;
}

export interface PullRequestInfo {
  number: number;
  url: string;
  draft: boolean;
  state: 'open' | 'closed';
  headSha: string;
}

export interface Viewer {
  id: number;
  login: string;
}

/**
 * Narrow view of the GitHub REST API used for publishing. Every method maps to one documented endpoint.
 * Implementations throw `PublishError` (codes: AUTH_EXPIRED, FORBIDDEN, RATE_LIMITED, NOT_FOUND, CONFLICT,
 * VALIDATION, NETWORK, SERVER). No method merges, approves, deletes or force-updates anything.
 */
export interface GitHubApi {
  viewer(): Promise<Viewer>;
  getRepo(owner: string, name: string): Promise<RepoInfo | null>;
  getBranchSha(owner: string, name: string, branch: string): Promise<string | null>;
  createFork(owner: string, name: string): Promise<{ owner: string; name: string }>;
  getCommit(owner: string, name: string, sha: string): Promise<CommitInfo | null>;
  /** Git file modes of `paths` in `treeSha` (missing paths are absent from the map). */
  getTreeModes(owner: string, name: string, treeSha: string, paths: string[]): Promise<Map<string, string>>;
  createTree(owner: string, name: string, baseTree: string, entries: TreeEntry[]): Promise<string>;
  createCommit(
    owner: string,
    name: string,
    input: { message: string; tree: string; parents: string[] },
  ): Promise<string>;
  /** Creates `refs/heads/<branch>`. Throws CONFLICT when it already exists. Never updates an existing ref. */
  createBranch(owner: string, name: string, branch: string, sha: string): Promise<void>;
  findPullRequest(owner: string, name: string, head: string): Promise<PullRequestInfo | null>;
  createDraftPullRequest(input: {
    owner: string;
    name: string;
    title: string;
    body: string;
    head: string;
    base: string;
  }): Promise<PullRequestInfo>;
}
