import { afterEach, describe, expect, it, vi } from "vitest";

const ISSUER = "https://login.example.test/realms/sq-staff";

vi.mock("openid-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openid-client")>();
  return {
    ...actual,
    discovery: vi.fn(
      async () =>
        new actual.Configuration(
          { issuer: ISSUER, token_endpoint: `${ISSUER}/protocol/openid-connect/token` },
          "hcis-api",
          "synthetic-machine-secret",
        ),
    ),
    clientCredentialsGrant: vi.fn(async () => ({ access_token: "synthetic-machine-token" })),
  };
});

import { SqHubApplicationAccessClient } from "../src/modules/auth/application-access.js";

const ACCESS_CHECK_URL = "https://hub.example.test/internal/v1/application-access/check";

describe("SQ Hub application access check", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends only issuer and subject, never the held ID token", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ allowed: true, applicationKey: "hcis", decision: "active_grant" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new SqHubApplicationAccessClient(
      ISSUER,
      "hcis-api",
      "synthetic-machine-secret",
      ACCESS_CHECK_URL,
    );
    const allowed = await client.isAllowed({
      issuer: ISSUER,
      subject: "synthetic-subject",
      idToken: "synthetic.id.token",
    });

    expect(allowed).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(ACCESS_CHECK_URL);
    expect(JSON.parse(init.body as string)).toEqual({
      identity: { issuer: ISSUER, subject: "synthetic-subject" },
      applicationKey: "hcis",
    });
    expect(init.body as string).not.toContain("synthetic.id.token");
  });
});
