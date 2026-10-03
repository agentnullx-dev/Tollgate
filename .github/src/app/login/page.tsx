import type { Metadata } from "next";
import { AuthError } from "next-auth";
import { redirect } from "next/navigation";
import { enabledProviders, signIn } from "@/auth";
import { GateMark } from "@/components/console/Sidebar";

export const metadata: Metadata = { title: "Sign in to Tollgate" };
export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  SessionRevoked: "Your access was removed or your account was disabled. Sign in again or contact an admin.",
  CredentialsSignin: "No active account uses that email address.",
  AccessDenied: "Your account is not allowed to sign in.",
  OAuthAccountNotLinked: "This email is already linked to another sign-in method. Use the one you signed up with.",
  Configuration: "Sign-in is misconfigured. Contact your administrator.",
};

function safeCallback(raw: string | undefined): string {
  return raw && raw.startsWith("/") && !raw.startsWith("//") ? raw : "/dashboard";
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ callbackUrl?: string; error?: string }> }) {
  const params = await searchParams;
  const redirectTo = safeCallback(params.callbackUrl);
  const providers = enabledProviders();
  const error = params.error ? ERRORS[params.error] ?? "Sign-in failed. Try again." : null;

  async function signInWith(formData: FormData) {
    "use server";
    const provider = String(formData.get("provider") ?? "");
    const target = safeCallback(String(formData.get("redirectTo") ?? ""));
    try {
      if (provider === "dev-login") {
        await signIn("dev-login", { email: String(formData.get("email") ?? ""), redirectTo: target });
      } else {
        await signIn(provider, { redirectTo: target });
      }
    } catch (err) {
      // signIn throws a redirect on success; only AuthErrors are real failures.
      if (err instanceof AuthError) redirect(`/login?error=${encodeURIComponent(err.type)}&callbackUrl=${encodeURIComponent(target)}`);
      throw err;
    }
  }

  const oauth = providers.filter((p) => p.kind === "oauth");
  const dev = providers.find((p) => p.kind === "credentials");

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2.5">
          <GateMark className="h-8 w-8 text-ink" />
          <span className="text-xl font-semibold tracking-[-0.02em]">Tollgate</span>
        </div>
        <div className="panel p-6">
          <h1 className="text-lg font-semibold">Sign in</h1>
          <p className="mt-1 text-sm text-ink-soft">Use your company account to open the console.</p>

          {error && (
            <p role="alert" className="mt-4 rounded-md bg-signal-soft px-3 py-2 text-sm text-signal">
              {error}
            </p>
          )}

          <div className="mt-5 flex flex-col gap-2">
            {oauth.map((p) => (
              <form key={p.id} action={signInWith}>
                <input type="hidden" name="provider" value={p.id} />
                <input type="hidden" name="redirectTo" value={redirectTo} />
                <button type="submit" className="w-full rounded-md border border-rule bg-panel px-3 py-2 text-sm font-medium hover:border-ink">
                  Continue with {p.name}
                </button>
              </form>
            ))}
          </div>

          {dev && (
            <form action={signInWith} className="mt-5 border-t border-rule pt-5">
              <input type="hidden" name="provider" value="dev-login" />
              <input type="hidden" name="redirectTo" value={redirectTo} />
              <label className="flex flex-col gap-1.5 text-sm">
                <span className="font-medium">Development login</span>
                <input
                  name="email"
                  type="email"
                  required
                  defaultValue="dev@acme.test"
                  className="rounded-md border border-rule px-3 py-2 outline-none focus:border-ink"
                />
                <span className="text-xs text-ink-soft">Seeded users: dev@acme.test (admin), developer@acme.test, viewer@acme.test.</span>
              </label>
              <button type="submit" className="mt-3 w-full rounded-md bg-ink px-3 py-2 text-sm font-semibold text-white">
                Sign in
              </button>
            </form>
          )}

          {oauth.length === 0 && !dev && (
            <p className="mt-4 text-sm text-ink-soft">
              No sign-in method is configured. Set Microsoft Entra ID, Google or GitHub credentials, or AUTH_DEV_LOGIN=true for local development.
            </p>
          )}
        </div>
      </div>
    </main>
  );
}
