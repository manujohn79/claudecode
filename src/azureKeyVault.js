// Loads ANTHROPIC_API_KEY from Azure Key Vault at startup, as a plain REST client (no
// @azure/identity or @azure/keyvault-secrets SDK), to keep this project's zero-dependency,
// hand-rolled-HTTP-client style (see src/claude.js). Auth is a service-principal client-credentials
// flow: set AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET and AZURE_KEY_VAULT_URL (see
// .env.example). The service principal needs "get secret" on the vault (the built-in "Key Vault
// Secrets User" RBAC role, or a classic access policy with Get on secrets).
import { verifyApiKey } from './claude.js';

const KEY_VAULT_API_VERSION = '7.4';

async function getAccessToken({ tenantId, clientId, clientSecret }) {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'https://vault.azure.net/.default'
  });
  let res;
  try {
    res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(15_000)
    });
  } catch {
    throw new Error('Could not reach login.microsoftonline.com (network or proxy/certificate issue)');
  }
  if (!res.ok) {
    // Azure AD error bodies are JSON with error/error_description; never echo the client secret.
    const text = await res.text();
    throw new Error(`Azure AD token request failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  if (!data.access_token) throw new Error('Azure AD response did not include an access_token');
  return data.access_token;
}

// Fetches one secret's current value from Key Vault. Throws with a message safe to log (never
// includes the client secret or the fetched value itself).
export async function fetchKeyVaultSecret({ vaultUrl, secretName, tenantId, clientId, clientSecret }) {
  const accessToken = await getAccessToken({ tenantId, clientId, clientSecret });
  const url = `${vaultUrl.replace(/\/+$/, '')}/secrets/${encodeURIComponent(secretName)}?api-version=${KEY_VAULT_API_VERSION}`;
  let res;
  try {
    res = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new Error(`Could not reach ${vaultUrl} (network or proxy/certificate issue)`);
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Key Vault secret request failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  if (typeof data.value !== 'string' || !data.value) throw new Error('Key Vault response did not include a secret value');
  return data.value;
}

// Called once at startup. Never throws: a vault outage or misconfiguration just leaves the app
// in offline mock mode (same as not setting ANTHROPIC_API_KEY at all), logged clearly so it's
// obvious why. Returns true only when a verified key was loaded.
export async function loadAnthropicKeyFromVault() {
  if (process.env.ANTHROPIC_API_KEY) return false; // .env / manual key already present; vault is a fallback source, not an override

  const tenantId = process.env.AZURE_TENANT_ID;
  const clientId = process.env.AZURE_CLIENT_ID;
  const clientSecret = process.env.AZURE_CLIENT_SECRET;
  const vaultUrl = process.env.AZURE_KEY_VAULT_URL;
  const secretName = process.env.AZURE_SECRET_NAME || 'anthropic-api-key';
  if (!tenantId || !clientId || !clientSecret || !vaultUrl) return false; // not configured; stay quiet

  try {
    const secret = await fetchKeyVaultSecret({ vaultUrl, secretName, tenantId, clientId, clientSecret });
    const verified = await verifyApiKey(secret);
    if (!verified.ok) {
      console.error(`Fetched a key from Azure Key Vault ("${secretName}") but Anthropic rejected it: ${verified.error}`);
      return false;
    }
    process.env.ANTHROPIC_API_KEY = secret;
    console.log(`Loaded and verified ANTHROPIC_API_KEY from Azure Key Vault (${vaultUrl}, secret "${secretName}").`);
    return true;
  } catch (err) {
    console.error(`Could not load ANTHROPIC_API_KEY from Azure Key Vault: ${err.message}`);
    return false;
  }
}
