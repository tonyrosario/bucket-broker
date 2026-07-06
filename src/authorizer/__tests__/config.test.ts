import { SSMClient, GetParametersCommand } from "@aws-sdk/client-ssm";
import { mockClient } from "aws-sdk-client-mock";
import { loadOidcConfig, type OidcParamNames } from "../src/config";
import { AuthDenied } from "../src/errors";

const ssmMock = mockClient(SSMClient);

const NAMES: OidcParamNames = {
  issuer: "/bucket-broker/oidc/issuer",
  audience: "/bucket-broker/oidc/audience",
  jwksUri: "/bucket-broker/oidc/jwks-uri",
};

describe("loadOidcConfig", () => {
  beforeEach(() => ssmMock.reset());

  it("loads issuer/audience/jwksUri from SSM with decryption", async () => {
    ssmMock.on(GetParametersCommand).resolves({
      Parameters: [
        { Name: NAMES.issuer, Value: "https://idp.example.com" },
        { Name: NAMES.audience, Value: "api://bucket-broker" },
        { Name: NAMES.jwksUri, Value: "https://idp.example.com/keys" },
      ],
    });

    const config = await loadOidcConfig(new SSMClient({}), NAMES);
    expect(config).toEqual({
      issuer: "https://idp.example.com",
      audience: "api://bucket-broker",
      jwksUri: "https://idp.example.com/keys",
    });

    const call = ssmMock.commandCalls(GetParametersCommand)[0];
    expect(call.args[0].input.WithDecryption).toBe(true);
    expect(call.args[0].input.Names).toEqual([NAMES.issuer, NAMES.audience, NAMES.jwksUri]);
  });

  it("fails closed when a parameter is missing", async () => {
    ssmMock.on(GetParametersCommand).resolves({
      Parameters: [
        { Name: NAMES.issuer, Value: "https://idp.example.com" },
        { Name: NAMES.audience, Value: "api://bucket-broker" },
      ],
      InvalidParameters: [NAMES.jwksUri],
    });

    await expect(loadOidcConfig(new SSMClient({}), NAMES)).rejects.toMatchObject({ reason: "config_error" });
  });

  it("throws AuthDenied when SSM returns no parameters", async () => {
    ssmMock.on(GetParametersCommand).resolves({});
    await expect(loadOidcConfig(new SSMClient({}), NAMES)).rejects.toBeInstanceOf(AuthDenied);
  });
});
