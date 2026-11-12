import { readFileSync } from "node:fs";
import { App } from "octokit";
import { type GitHubPort, REPO_PERMISSIONS, type RepoPermission } from "./port.ts";

/**
 * 本物の GitHubPort（octokit の App）。GitHub を呼ぶので単体テストは書かず、振る舞いは testing.ts の
 * FakeGitHub と同じにする（FakeGitHub のテストで受付と Worker を確かめる）。
 *
 * - インストールは repo から引き（GET /repos/{owner}/{repo}/installation）、プロセスの中で覚える。
 *   App が入っていなければ例外（受付では「権限を確かめられない」= 500）
 * - インストールトークン（1時間で切れる）の発行と更新は octokit に任せ、保存しない
 */
export function createGitHubClient(options: { appId: string; privateKey: string }): GitHubPort {
  const app = new App({ appId: options.appId, privateKey: options.privateKey });
  const installations = new Map<string, number>();

  const split = (repo: string) => {
    const [owner, name] = repo.split("/");
    if (!owner || !name) throw new Error(`owner/name の形ではありません: ${repo}`);
    return { owner, repo: name };
  };

  async function installationOctokit(repo: string) {
    let id = installations.get(repo);
    if (id === undefined) {
      const { data } = await app.octokit.request(
        "GET /repos/{owner}/{repo}/installation",
        split(repo),
      );
      id = data.id;
      installations.set(repo, id);
    }
    return app.getInstallationOctokit(id);
  }

  return {
    async getPermission({ repo, user, signal }) {
      const octokit = await installationOctokit(repo);
      const { data } = await octokit.request(
        "GET /repos/{owner}/{repo}/collaborators/{username}/permission",
        { ...split(repo), username: user, ...(signal ? { request: { signal } } : {}) },
      );
      // role_name は maintain・triage を区別する。permission は admin・write・read・none だけ
      const role = (data.role_name ?? data.permission) as string;
      return (REPO_PERMISSIONS as readonly string[]).includes(role)
        ? (role as RepoPermission)
        : (data.permission as RepoPermission);
    },

    async addReaction({ repo, commentId, content }) {
      const octokit = await installationOctokit(repo);
      await octokit.request("POST /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions", {
        ...split(repo),
        comment_id: commentId,
        content,
      });
    },

    async createIssueComment({ repo, issueNumber, body }) {
      const octokit = await installationOctokit(repo);
      const { data } = await octokit.request(
        "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
        { ...split(repo), issue_number: issueNumber, body },
      );
      return data.html_url;
    },

    async getCloneAccess({ repo }) {
      const octokit = await installationOctokit(repo);
      const { data } = await octokit.request("GET /repos/{owner}/{repo}", split(repo));
      const auth = (await octokit.auth({ type: "installation" })) as { token: string };
      return { token: auth.token, defaultBranch: data.default_branch };
    },

    async getIssue({ repo, issueNumber }) {
      const octokit = await installationOctokit(repo);
      const { data } = await octokit.request("GET /repos/{owner}/{repo}/issues/{issue_number}", {
        ...split(repo),
        issue_number: issueNumber,
      });
      return { title: data.title, body: data.body ?? "" };
    },
  };
}

/** 秘密鍵（PEM）をファイルから読む（GITHUB_APP_PRIVATE_KEY_PATH。複数行なので環境変数に直接入れない） */
export function readPrivateKey(path: string): string {
  const key = readFileSync(path, "utf8");
  if (!key.includes("PRIVATE KEY-----")) {
    throw new Error(`GitHub App の秘密鍵（PEM）ではありません: ${path}`);
  }
  return key;
}
