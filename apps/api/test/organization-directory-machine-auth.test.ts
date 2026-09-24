import { createServer, type Server } from "node:http";

import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createOrganizationDirectoryMachineTokenVerifier } from "../src/modules/organization-directory/machine-auth.js";

let server: Server;
let issuer: string;
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
const audience = "hcis-organization-directory";
const allowedClient = "sq-hub-organization-directory";
const kid = "org-directory-test-key";

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  Object.assign(jwk, { kid, alg: "RS256", use: "sig" });

  server = createServer((request, response) => {
    if (request.url?.endsWith("/protocol/openid-connect/certs")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  issuer = `http://127.0.0.1:${address.port}/realms/test`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve()),
  );
});

async function token(input: {
  aud?: string;
  azp?: string;
  iss?: string;
  scope?: string;
} = {}) {
  return new SignJWT({
    azp: input.azp ?? allowedClient,
    scope: input.scope ?? "openid organization-directory.read",
  })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer(input.iss ?? issuer)
    .setAudience(input.aud ?? audience)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

function verifier() {
  return createOrganizationDirectoryMachineTokenVerifier({
    issuer,
    audience,
    allowedClients: new Set([allowedClient]),
    requiredScope: "organization-directory.read",
  });
}

describe("ORG-006 machine token verifier", () => {
  it("accepts only the dedicated client with expected audience and scope", async () => {
    await expect(verifier()(await token())).resolves.toEqual({ clientId: allowedClient });
  });

  it("rejects the wrong audience", async () => {
    await expect(verifier()(await token({ aud: "some-other-api" }))).rejects.toMatchObject({
      code: "INVALID_TOKEN",
    });
  });

  it("rejects a non-allowlisted client", async () => {
    await expect(verifier()(await token({ azp: "unknown-machine" }))).rejects.toMatchObject({
      code: "FORBIDDEN_CLIENT",
    });
  });

  it("rejects a token missing the directory read scope", async () => {
    await expect(verifier()(await token({ scope: "openid" }))).rejects.toMatchObject({
      code: "INSUFFICIENT_SCOPE",
    });
  });
});
