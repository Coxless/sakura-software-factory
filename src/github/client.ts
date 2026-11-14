import { readFileSync } from "node:fs";
import { App } from "octokit";
import {
  type BotIdentity,
  type CheckRunInfo,
  DraftUnavailableError,
  type GitHubPort,
  REPO_PERMISSIONS,
  type RepoPermission,
} from "./port.ts";

/**
 * 本物の GitHubPort（octokit の App）。GitHub を呼ぶので単体テストは書かず、振る舞いは testing.ts の
 * FakeGitHub と同じにする（FakeGitHub のテストで受付と Worker を確かめる）。
 *
 * - インストールは repo から引き（GET /repos/{owner}/{repo}/installation）、プロセスの中で覚える。
 *   App が入っていなければ例外（受付では「権限を確かめられない」= 500）
 * - インストールトークン（1時間で切れる）の発行と更新は octokit に任せ、保存しない
 * - auto-merge の有効化と Draft への変更は REST にないので GraphQL（008 research R6）
 * - CI のチェックとログは Checks・Actions の REST（009 research R1・R7）
 */
export function createGitHubClient(options: { appId: string; privateKey: string }): GitHubPort {
  const app = new App({ appId: options.appId, privateKey: options.privateKey });
  const installations = new Map<string, number>();
  let bot: BotIdentity | undefined;

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
      const labels = data.labels
        .map((label) => (typeof label === "string" ? label : (label.name ?? "")))
        .filter((name) => name !== "");
      return { title: data.title, body: data.body ?? "", labels };
    },

    async getBotIdentity({ repo }) {
      if (bot) return bot;
      // App の JWT で自分の slug を引き、ボットのアカウントの ID から noreply のアドレスを作る。
      // app.octokit（JWT）は /app 系以外を呼べない（auth-app がインストールの認証を求める）ので、/users はインストールで呼ぶ
      const { data: me } = await app.octokit.request("GET /app");
      if (!me?.slug) throw new Error("GitHub App の slug を取得できません");
      const login = `${me.slug}[bot]`;
      const octokit = await installationOctokit(repo);
      const { data: user } = await octokit.request("GET /users/{username}", {
        username: login,
      });
      bot = { name: login, email: `${user.id}+${login}@users.noreply.github.com` };
      return bot;
    },

    async createPullRequest({ repo, head, base, title, body, draft }) {
      const octokit = await installationOctokit(repo);
      try {
        const { data } = await octokit.request("POST /repos/{owner}/{repo}/pulls", {
          ...split(repo),
          head,
          base,
          title,
          body,
          draft,
        });
        return { number: data.number, url: data.html_url, nodeId: data.node_id };
      } catch (error) {
        const status = (error as { status?: number }).status;
        const message = error instanceof Error ? error.message : String(error);
        if (draft && status === 422 && /draft/i.test(message)) {
          throw new DraftUnavailableError(message);
        }
        throw error;
      }
    },

    async enableAutoMerge({ repo, nodeId }) {
      const octokit = await installationOctokit(repo);
      await octokit.graphql(
        `mutation($id: ID!) {
          enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: SQUASH }) {
            clientMutationId
          }
        }`,
        { id: nodeId },
      );
    },

    async updatePullRequestBody({ repo, number, body }) {
      const octokit = await installationOctokit(repo);
      await octokit.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", {
        ...split(repo),
        pull_number: number,
        body,
      });
    },

    async getPullRequest({ repo, number }) {
      const octokit = await installationOctokit(repo);
      const { data } = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
        ...split(repo),
        pull_number: number,
      });
      return {
        number: data.number,
        url: data.html_url,
        nodeId: data.node_id,
        state: data.state === "closed" ? "closed" : "open",
        merged: data.merged === true || data.merged_at !== null,
        draft: data.draft === true,
        autoMerge: data.auto_merge !== null && data.auto_merge !== undefined,
        headSha: data.head.sha,
        body: data.body ?? "",
      };
    },

    async getCheckRuns({ repo, sha }) {
      const octokit = await installationOctokit(repo);
      const runs = await octokit.paginate("GET /repos/{owner}/{repo}/commits/{ref}/check-runs", {
        ...split(repo),
        ref: sha,
        filter: "latest",
        per_page: 100,
      });
      return runs.map(
        (run): CheckRunInfo => ({
          id: run.id,
          name: run.name,
          status: run.status,
          conclusion: run.conclusion ?? null,
          app: run.app?.slug ?? null,
        }),
      );
    },

    async getCheckRunLog({ repo, check }) {
      const octokit = await installationOctokit(repo).catch(() => undefined);
      if (!octokit) return undefined;
      if (check.app === "github-actions") {
        try {
          // チェックの ID は Actions のジョブの ID と同じ。302 でプレーンテキストに飛ぶ
          const { data } = await octokit.request(
            "GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs",
            { ...split(repo), job_id: check.id },
          );
          const text =
            typeof data === "string"
              ? data
              : data instanceof ArrayBuffer
                ? new TextDecoder().decode(data)
                : String(data ?? "");
          if (text.trim() !== "") return text;
        } catch {
          // ログが消えた・権限がない → output の文を使う
        }
      }
      try {
        const { data } = await octokit.request("GET /repos/{owner}/{repo}/check-runs/{check_run_id}", {
          ...split(repo),
          check_run_id: check.id,
        });
        const text = [data.output?.title, data.output?.summary, data.output?.text]
          .filter((part): part is string => typeof part === "string" && part.trim() !== "")
          .join("\n\n");
        return text === "" ? undefined : text;
      } catch {
        return undefined;
      }
    },

    async convertToDraft({ repo, nodeId }) {
      const octokit = await installationOctokit(repo);
      await octokit.graphql(
        `mutation($id: ID!) {
          convertPullRequestToDraft(input: { pullRequestId: $id }) { clientMutationId }
        }`,
        { id: nodeId },
      );
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
