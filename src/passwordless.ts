import {
    AtLeast,
    PromiseResult,
    RegisterBeginResponse,    
    SigninBeginResponse,
    SigninMethod,
    TokenResponse
} from './types';

export interface Config {
    apiUrl: string;
    apiKey: string;
    origin: string;
    rpid: string;
}

export class Client {
    private config: Config = {
        apiUrl: 'https://v4.passwordless.dev',
        apiKey: '',
        origin: window.location.origin,
        rpid: window.location.hostname,
    }
    private abortController: AbortController = new AbortController();

    constructor(config: AtLeast<Config, 'apiKey'>) {
        Object.assign(this.config, config);
    }

    /**
     * Register a new credential to a user
     *
     * @param {string} token Token generated by your backend and the Passwordless API
     */
    public async register(token: string, credentialNickname: string): PromiseResult<TokenResponse> {
        try {            
            this.assertBrowserSupported();
            
            const registration = await this.registerBegin(token);
            if(registration.error) {
                console.error(registration.error);
                return { error: registration.error}                
            }

            registration.data.challenge = base64UrlToArrayBuffer(registration.data.challenge);
            registration.data.user.id = base64UrlToArrayBuffer(registration.data.user.id);
            registration.data.excludeCredentials?.forEach((cred) => {
                cred.id = base64UrlToArrayBuffer(cred.id);
            });

            const credential = await navigator.credentials.create({
                publicKey: registration.data,
            }) as PublicKeyCredential;

            if (!credential) {
                const error = {
                    from: "client",
                    errorCode: "failed_create_credential",
                    title: "Failed to create credential (navigator.credentials.create returned null)",
                };
                console.error(error);
                return { error };
            }

            return await this.registerComplete(credential, registration.session, credentialNickname);
            
            // next steps
            // return a token from the API
            // Add a type to the token (method/action)
            
        } catch (caughtError: any) {
            
            const errorMessage = getErrorMessage(caughtError);                            
            const error = {
                from: "client",
                errorCode: "unknown",
                title: errorMessage,
            };
            console.error(caughtError);
            console.error(error);
            
            return { error };
        }
    }

    /**
     * Sign in a user using the userid
     * @param {string} userId
     * @returns
     */
    public async signinWithId(userId: string): PromiseResult<TokenResponse> {
        return this.signin({userId})
    }

    

    /**
     * Sign in a user using an alias
     * @param {string} alias
     * @returns a verify_token
     */
    public async signinWithAlias(alias: string): PromiseResult<TokenResponse> {
        return this.signin({alias})
    }

    /**
     * Sign in a user using autofill UI (a.k.a conditional) sign in
     * @returns a verify_token
     */
    public async signinWithAutofill(): PromiseResult<TokenResponse> {
        if (!await isAutofillSupported()) {
            throw new Error("Autofill authentication (conditional meditation) is not supported in this browser");
        }
        return this.signin({autofill: true});
    }

    /**
     * Sign in a user using discoverable credentials     
     * @returns a verify_token
     */
    public async signinWithDiscoverable(): PromiseResult<TokenResponse> {
        return this.signin({discoverable: true});
    }

    public abort() {
        if (this.abortController) {
            this.abortController.abort();
        }
    }

    public isPlatformSupported(): Promise<boolean> {
        return isPlatformSupported();
    }

    public isBrowserSupported(): boolean {
        return isBrowserSupported();
    }

    public isAutofillSupported(): Promise<boolean> {
        return isAutofillSupported();
    }

    private async registerBegin(token: string): PromiseResult<RegisterBeginResponse> {
        const response = await fetch(`${this.config.apiUrl}/register/begin`, {
            method: 'POST',
            headers: this.createHeaders(),
            body: JSON.stringify({
                token,
                RPID: this.config.rpid,
                Origin: this.config.origin,
            }),
        });

        const res = await response.json();
        if (response.ok) {
            return res;
        }

        return { error: {...res, from: "server"}};
    }

    private async registerComplete(
        credential: PublicKeyCredential,
        session: string,
        credentialNickname: string,
    ): PromiseResult<TokenResponse> {
        const attestationResponse = credential.response as AuthenticatorAttestationResponse;

        const response = await fetch(`${this.config.apiUrl}/register/complete`, {
            method: 'POST',
            headers: this.createHeaders(),
            body: JSON.stringify({
                session: session,
                response: {
                    id: credential.id,
                    rawId: arrayBufferToBase64Url(credential.rawId),
                    type: credential.type,
                    extensions: credential.getClientExtensionResults(),
                    response: {
                        AttestationObject: arrayBufferToBase64Url(
                            attestationResponse.attestationObject
                        ),
                        clientDataJson: arrayBufferToBase64Url(
                            attestationResponse.clientDataJSON
                        ),
                    },
                },
                nickname: credentialNickname,
                RPID: this.config.rpid,
                Origin: this.config.origin,
            }),
        });

        const res = await response.json();
        if (response.ok) {
            return res;
        }

        return { error: {...res, from: "server"}};
    }

    /**
     * Sign in a user
     *
     * @param {SigninMethod} Object containing either UserID or Alias
     * @returns
     */
    private async signin(signinMethod: SigninMethod): PromiseResult<TokenResponse> {
        try {
            this.assertBrowserSupported();
            this.handleAbort();
            
            // if signinMethod is undefined, set it to an empty object
            // this will cause a login using discoverable credentials
            if(!signinMethod) {
                signinMethod = { discoverable: true };
            }            
                    
            const signin = await this.signinBegin(signinMethod);
            if(signin.error) {
                return signin;
            }

            signin.data.challenge = base64UrlToArrayBuffer(signin.data.challenge);
            signin.data.allowCredentials?.forEach((cred) => {
                cred.id = base64UrlToArrayBuffer(cred.id);
            });

            const credential = await navigator.credentials.get({
                publicKey: signin.data,
                mediation: 'autofill' in signinMethod ? "conditional" as CredentialMediationRequirement : undefined, // Typescript doesn't know about 'conditational' yet
                signal: this.abortController.signal,
            }) as PublicKeyCredential;

            const response = await this.signinComplete(credential, signin.session);
            return response;
            
        } catch (caughtError: any) {           
            const errorMessage = getErrorMessage(caughtError);
            const error = {
                from: "client",
                errorCode: "unknown",
                title: errorMessage,
            };
            console.error(caughtError);
            console.error(error);

            return { error };
        }
    }

    private async signinBegin(signinMethod: SigninMethod): PromiseResult<SigninBeginResponse> {
        const response = await fetch(`${this.config.apiUrl}/signin/begin`, {
            method: 'POST',
            headers: this.createHeaders(),
            body: JSON.stringify({
                userId: "userId" in signinMethod ? signinMethod.userId : undefined,
                alias: "alias" in signinMethod ? signinMethod.alias : undefined,
                RPID: this.config.rpid,
                Origin: this.config.origin,
            }),
        });

        const res = await response.json();
        if (response.ok) {
            return res;
        }

        return { error: {...res, from: "server"}};
    }

    private async signinComplete(
        credential: PublicKeyCredential,
        session: string,
    ): PromiseResult<TokenResponse> {
        const assertionResponse = credential.response as AuthenticatorAssertionResponse;

        const response = await fetch(`${this.config.apiUrl}/signin/complete`, {
            method: 'POST',
            headers: this.createHeaders(),
            body: JSON.stringify({
                session: session,
                response: {
                    id: credential.id,
                    rawId: arrayBufferToBase64Url(new Uint8Array(credential.rawId)),
                    type: credential.type,
                    extensions: credential.getClientExtensionResults(),
                    response: {
                        authenticatorData: arrayBufferToBase64Url(
                            assertionResponse.authenticatorData,
                        ),
                        clientDataJson: arrayBufferToBase64Url(
                            assertionResponse.clientDataJSON
                        ),
                        signature: arrayBufferToBase64Url(
                            assertionResponse.signature
                        ),
                    },
                },
                RPID: this.config.rpid,
                Origin: this.config.origin,
            }),
        });

        const res = await response.json();
        if (response.ok) {
            return res;
        }

        return { error: {...res, from: "server"}};
    }

    private handleAbort() {
        this.abort();
        this.abortController = new AbortController();
    }

    private assertBrowserSupported(): void {
        if (!isBrowserSupported()) {
            throw new Error('WebAuthn and PublicKeyCredentials are not supported on this browser/device');
        }
    }

    private createHeaders(): Record<string, string> {
        return {
            ApiKey: this.config.apiKey,
            'Content-Type': 'application/json',
            'Client-Version': 'js-1.1.0'
        };
    }
}

export async function isPlatformSupported(): Promise<boolean> {
    if (!isBrowserSupported()) return false;
    return PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
}

export function isBrowserSupported(): boolean {
    return window.PublicKeyCredential !== undefined && typeof window.PublicKeyCredential === 'function';
}

export async function isAutofillSupported(): Promise<boolean> {
    const PublicKeyCredential = window.PublicKeyCredential as any; // Typescript lacks support for this
    if (!PublicKeyCredential.isConditionalMediationAvailable) return false;
    return PublicKeyCredential.isConditionalMediationAvailable() as Promise<boolean>;
}

function base64ToBase64Url(base64: string): string {
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=*$/g, '');
}

function base64UrlToBase64(base64Url: string): string {
    return base64Url.replace(/-/g, '+').replace(/_/g, '/');
}

function base64UrlToArrayBuffer(base64UrlString: string | BufferSource): ArrayBuffer {
    // improvement: Remove BufferSource-type and add proper types upstream
    if (typeof base64UrlString !== 'string') {
        const msg = "Cannot convert from Base64Url to ArrayBuffer: Input was not of type string";
        console.error(msg, base64UrlString);
        throw new TypeError(msg);
    }

    const base64Unpadded = base64UrlToBase64(base64UrlString);
    const paddingNeeded = (4 - (base64Unpadded.length % 4)) % 4;
    const base64Padded = base64Unpadded.padEnd(base64Unpadded.length + paddingNeeded, "=");

    const binary = window.atob(base64Padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }

    return bytes;
}

function arrayBufferToBase64Url(buffer: ArrayBuffer | Uint8Array): string {
    const uint8Array = (() => {
        if (Array.isArray(buffer)) return Uint8Array.from(buffer);
        if (buffer instanceof ArrayBuffer) return new Uint8Array(buffer);
        if (buffer instanceof Uint8Array) return buffer;

        const msg = "Cannot convert from ArrayBuffer to Base64Url. Input was not of type ArrayBuffer, Uint8Array or Array";
        console.error(msg, buffer);
        throw new Error(msg);
    })();

    let string = '';
    for (let i = 0; i < uint8Array.byteLength; i++) {
        string += String.fromCharCode(uint8Array[i]);
    }

    const base64String = window.btoa(string);
    return base64ToBase64Url(base64String);
}

type ErrorWithMessage = {
    message: string
}

function isErrorWithMessage(error: unknown): error is ErrorWithMessage {
    return (
        typeof error === 'object' &&
        error !== null &&
        'message' in error &&
        typeof (error as Record<string, unknown>).message === 'string'
    )
}

function toErrorWithMessage(maybeError: unknown): ErrorWithMessage {
    if (isErrorWithMessage(maybeError)) return maybeError

    try {
        return new Error(JSON.stringify(maybeError))
    } catch {
        // fallback in case there's an error stringifying the maybeError
        // like with circular references for example.
        return new Error(String(maybeError))
    }
}

function getErrorMessage(error: unknown) {
    return toErrorWithMessage(error).message
}