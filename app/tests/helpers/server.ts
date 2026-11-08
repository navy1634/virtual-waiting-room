import { createServer } from "node:net";
import { databaseEnvironment } from "./database.ts";

const PROJECT_ROOT = process.cwd();

export interface ApiServerOptions {
  issuerUrl?: string;
  internalUrl: string;
  applicationName?: string;
  capacity?: number;
  appReturnOrigin?: string;
  sessionCookieDomain?: string;
}

export interface ApiServer {
  origin: string;
  stop: () => Promise<void>;
}

async function findFreePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });

  const address = probe.address();

  if (!address || typeof address === "string") {
    throw new Error("A free local TCP port could not be allocated");
  }

  await new Promise<void>((resolve, reject) => {
    probe.close((error) => (error ? reject(error) : resolve()));
  });

  return address.port;
}

export async function startApiServer(
  options: ApiServerOptions,
): Promise<ApiServer> {
  const port = await findFreePort();
  const origin = `http://127.0.0.1:${port}`;
  const executablePath = Bun.env.PATH;

  // test 用の値だけを渡し、開発者の .env が子 API process に混ざるのを防ぐ
  const child = Bun.spawn(
    ["bun", "--no-env-file", "src/server/http/server.ts"],
    {
      cwd: PROJECT_ROOT,
      env: {
        ...(executablePath ? { PATH: executablePath } : {}),
        ...databaseEnvironment,
        ...(options.applicationName
          ? { DATABASE_APPLICATION_NAME: options.applicationName }
          : {}),
        WAITING_ROOM_CAPACITY: String(options.capacity ?? 1),
        APP_ORIGIN: origin,
        ...(options.appReturnOrigin
          ? { APP_RETURN_ORIGIN: options.appReturnOrigin }
          : {}),
        ...(options.sessionCookieDomain
          ? { SESSION_COOKIE_DOMAIN: options.sessionCookieDomain }
          : {}),
        OIDC_ISSUER_URL: options.issuerUrl ?? "http://127.0.0.1:1",
        OIDC_INTERNAL_URL: options.internalUrl,
        OIDC_CLIENT_ID: "test-client",
        OIDC_CLIENT_SECRET: "test-client-secret",
        OIDC_REDIRECT_URI: `${origin}/auth/callback`,
        HOST: "127.0.0.1",
        PORT: String(port),
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();

  try {
    await waitForServer(child, origin);
  } catch (error) {
    child.kill();
    await child.exited;
    const output = `${await stdout}\n${await stderr}`.trim();
    throw new Error(`${String(error)}\n${output}`);
  }

  return {
    origin,
    stop: async () => {
      if (child.exitCode === null) {
        child.kill();
      }

      await child.exited;
      await stdout;
      await stderr;
    },
  };
}

async function waitForServer(
  child: Bun.Subprocess,
  origin: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `API process exited with code ${child.exitCode} before serving GET /`,
      );
    }

    try {
      const response = await fetch(`${origin}/`, {
        redirect: "manual",
        signal: AbortSignal.timeout(250),
      });

      if (response.status === 200 || response.status === 302) {
        return;
      }
    } catch {
      await Bun.sleep(50);
    }
  }

  throw new Error("API process did not serve GET / within five seconds");
}
