import { json, parseJsonBody } from "@/lib/http";
import { CreateApiKeySchema, DEVELOPER_GRANTABLE_SCOPES } from "@/lib/schemas";
import { Errors } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { generateApiKey } from "@/lib/auth";
import { withSessionHandler } from "@/lib/session";
import { recordAudit } from "@/lib/services/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** List the organization's API keys. Secrets are never stored, so never returned. */
export const GET = withSessionHandler({ permission: "api-keys:read" }, async ({ session }) => {
  const keys = await prisma.apiKey.findMany({
    where: { organizationId: session.organizationId },
    include: { project: { select: { name: true } }, createdBy: { select: { email: true } } },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return json({
    data: keys.map((k) => ({
      id: k.id,
      name: k.name,
      prefix: `tg_live_${k.prefix}_…`,
      projectId: k.projectId,
      projectName: k.project.name,
      scopes: k.scopes,
      createdBy: k.createdBy?.email ?? null,
      lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
      expiresAt: k.expiresAt?.toISOString() ?? null,
      revokedAt: k.revokedAt?.toISOString() ?? null,
      createdAt: k.createdAt.toISOString(),
    })),
  });
});

/**
 * Create an API key. Developers may grant gateway and read scopes; scopes that
 * change budgets, agents or the organization require an admin. The plaintext
 * key is returned exactly once.
 */
export const POST = withSessionHandler({ permission: "api-keys:create" }, async ({ req, session, requestId }) => {
  const input = await parseJsonBody(req, CreateApiKeySchema, 8_000);

  const elevated = input.scopes.filter((s) => !DEVELOPER_GRANTABLE_SCOPES.has(s));
  if (elevated.length > 0 && session.role !== "org:admin") {
    throw Errors.forbidden("Only admins can create keys with these scopes.", { scopes: elevated });
  }

  const project = await prisma.project.findFirst({
    where: { id: input.projectId, organizationId: session.organizationId, archivedAt: null },
    select: { id: true, name: true },
  });
  if (!project) throw Errors.notFound("Project", input.projectId);

  const { plaintext, prefix, hashedKey } = generateApiKey();
  const expiresAt = input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000) : null;

  const key = await prisma.$transaction(async (tx) => {
    const created = await tx.apiKey.create({
      data: {
        organizationId: session.organizationId,
        projectId: project.id,
        name: input.name,
        prefix,
        hashedKey,
        scopes: input.scopes,
        createdById: session.userId,
        expiresAt,
      },
    });
    await recordAudit(
      {
        organizationId: session.organizationId,
        actorType: "USER",
        actorId: session.userId,
        action: "api_key.created",
        targetType: "api_key",
        targetId: created.id,
        after: { name: created.name, prefix, projectId: project.id, scopes: input.scopes, expiresAt: expiresAt?.toISOString() ?? null },
        requestId,
      },
      tx,
    );
    return created;
  });

  return json(
    {
      data: {
        id: key.id,
        name: key.name,
        projectId: project.id,
        projectName: project.name,
        scopes: key.scopes,
        expiresAt: key.expiresAt?.toISOString() ?? null,
        apiKey: plaintext,
        warning: "Store this key now. It cannot be shown again.",
      },
    },
    { status: 201, headers: { "cache-control": "no-store" } },
  );
});
