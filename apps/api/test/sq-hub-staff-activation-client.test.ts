// AUTH-002-INVITE / HUB-IMPL-024: the real HTTP client HCIS uses to ask SQ Hub for an Akun SQ.
//
// Every other invitation test replaces this client with a fake, so the request HCIS actually
// sends (URL, method, headers, body) and the way it reads SQ Hub's answers were never checked.
// OPS-PILOT-TT-001 goal 1 ("undangan Akun SQ benar-benar berfungsi") stands on exactly this code.
// The OIDC machine-token step is stubbed; the HTTP exchange with SQ Hub is not.

import { beforeEach, describe, expect, it, vi } from "vitest";

const oidcMock = vi.hoisted(() => ({
  discovery: vi.fn(),
  clientCredentialsGrant: vi.fn(),
}));
vi.mock("openid-client", () => oidcMock);

import {
  SqHubStaffActivationClient,
  StaffActivationRejectedError,
  StaffActivationUnavailableError,
  staffActivationInviteUrl,
} from "../src/modules/auth/sq-hub-staff-activation.js";

const ISSUER = "https://login.example.test/realms/sq-staff/";
const INVITE_URL = "https://hub.example.test/internal/v1/staff-activation/invite";
const EMPLOYEE = "11111111-2222-4333-8444-555555555555";
const ACCOUNT = "99999999-8888-4777-8666-555555555555";

const valid = {
  identity: { issuer: "https://login.example.test/realms/sq-staff", subject: "kc-subject" },
  employeeId: `hcis:employee:${EMPLOYEE}`,
  credentialInitialization: "sent",
  applicationAccess: "granted",
};

function respond(status: number, body: unknown) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status, headers: { "content-type": "application/json" },
  });
}

describe("SqHubStaffActivationClient (HUB-IMPL-024 contract)", () => {
  beforeEach(() => {
    oidcMock.discovery.mockReset().mockResolvedValue({ configuration: true });
    oidcMock.clientCredentialsGrant.mockReset().mockResolvedValue({ access_token: "machine-token" });
  });

  function client(fetchImpl: typeof fetch) {
    return new SqHubStaffActivationClient(ISSUER, "hcis-machine", "secret", INVITE_URL, fetchImpl);
  }

  it("sends only the NIP and the asking account, as a bearer-authenticated JSON POST", async () => {
    const fetchImpl = vi.fn(async () => respond(200, valid));
    const result = await client(fetchImpl as unknown as typeof fetch).invite({ employeeNumber: "NIP-1", accountId: ACCOUNT });

    expect(result).toEqual(valid);
    expect(oidcMock.discovery).toHaveBeenCalledWith(new URL("https://login.example.test/realms/sq-staff"), "hcis-machine", "secret");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(INVITE_URL);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer machine-token", "Content-Type": "application/json", Accept: "application/json",
    });
    // HUB-IMPL-024: the body is strict — no name, e-mail, phone or identity.
    expect(JSON.parse(String(init.body))).toEqual({ employeeNumber: "NIP-1", requestedBy: { accountId: ACCOUNT } });
  });

  it("reuses one discovery for several invitations", async () => {
    const fetchImpl = vi.fn(async () => respond(200, valid));
    const hub = client(fetchImpl as unknown as typeof fetch);
    await hub.invite({ employeeNumber: "NIP-1", accountId: ACCOUNT });
    await hub.invite({ employeeNumber: "NIP-2", accountId: ACCOUNT });
    expect(oidcMock.discovery).toHaveBeenCalledTimes(1);
    expect(oidcMock.clientCredentialsGrant).toHaveBeenCalledTimes(2);
  });

  it("reports a machine-token failure as unavailable and never calls SQ Hub", async () => {
    oidcMock.clientCredentialsGrant.mockRejectedValue(new Error("invalid_client"));
    const fetchImpl = vi.fn();
    await expect(client(fetchImpl as unknown as typeof fetch).invite({ employeeNumber: "NIP-1", accountId: ACCOUNT }))
      .rejects.toMatchObject({ name: "StaffActivationUnavailableError", reason: "machine_token" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("retries discovery after it failed once", async () => {
    oidcMock.discovery.mockRejectedValueOnce(new Error("down"));
    const fetchImpl = vi.fn(async () => respond(200, valid));
    const hub = client(fetchImpl as unknown as typeof fetch);
    await expect(hub.invite({ employeeNumber: "NIP-1", accountId: ACCOUNT })).rejects.toBeInstanceOf(StaffActivationUnavailableError);
    await expect(hub.invite({ employeeNumber: "NIP-1", accountId: ACCOUNT })).resolves.toEqual(valid);
  });

  it.each([
    [409, { error: "STAFF_IDENTITY_DISABLED" }, "STAFF_IDENTITY_DISABLED"],
    [404, { error: "HCIS_EMPLOYEE_NOT_FOUND" }, "HCIS_EMPLOYEE_NOT_FOUND"],
    [403, { error: "FORBIDDEN_CLIENT" }, "FORBIDDEN_CLIENT"],
    [400, { error: "not a code; <script>" }, "HTTP_400"],
    [401, undefined, "HTTP_401"],
  ])("maps a %i refusal to a stable code (%s)", async (status, body, code) => {
    const fetchImpl = vi.fn(async () => respond(status, body));
    const error = await client(fetchImpl as unknown as typeof fetch)
      .invite({ employeeNumber: "NIP-1", accountId: ACCOUNT }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StaffActivationRejectedError);
    expect(error).toMatchObject({ status, code });
  });

  it.each([
    [503, { error: "HCIS_VERIFY_UNAVAILABLE" }, "HCIS_VERIFY_UNAVAILABLE"],
    [500, undefined, "http_500"],
    [429, { error: "SLOW_DOWN" }, "SLOW_DOWN"],
    [408, undefined, "http_408"],
  ])("treats %i as retryable unavailability (%s)", async (status, body, reason) => {
    const fetchImpl = vi.fn(async () => respond(status, body));
    await expect(client(fetchImpl as unknown as typeof fetch).invite({ employeeNumber: "NIP-1", accountId: ACCOUNT }))
      .rejects.toMatchObject({ name: "StaffActivationUnavailableError", reason });
  });

  it("refuses a 200 that does not match the contract, and a network failure", async () => {
    for (const body of [
      { ...valid, employeeId: "employee-1" },
      { ...valid, credentialInitialization: "maybe" },
      { ...valid, identity: { issuer: "not-a-url", subject: "x" } },
    ]) {
      const fetchImpl = vi.fn(async () => respond(200, body));
      await expect(client(fetchImpl as unknown as typeof fetch).invite({ employeeNumber: "NIP-1", accountId: ACCOUNT }))
        .rejects.toMatchObject({ reason: "invalid_response" });
    }
    const offline = vi.fn(async () => { throw new TypeError("fetch failed"); });
    await expect(client(offline as unknown as typeof fetch).invite({ employeeNumber: "NIP-1", accountId: ACCOUNT }))
      .rejects.toMatchObject({ reason: "network" });
  });
});

describe("staffActivationInviteUrl", () => {
  it("derives the invite route from the application-access origin, as production is configured", () => {
    expect(staffActivationInviteUrl({ SQ_HUB_APPLICATION_ACCESS_URL: "http://127.0.0.1:3302/internal/v1/application-access/check" }))
      .toBe("http://127.0.0.1:3302/internal/v1/staff-activation/invite");
  });

  it("prefers an explicit override and is null without SQ Hub", () => {
    expect(staffActivationInviteUrl({
      SQ_HUB_APPLICATION_ACCESS_URL: "http://127.0.0.1:3302/x", SQ_HUB_STAFF_ACTIVATION_URL: "https://hub.example.test/i",
    })).toBe("https://hub.example.test/i");
    expect(staffActivationInviteUrl({})).toBeNull();
  });
});
