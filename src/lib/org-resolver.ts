import { eq } from "drizzle-orm";
import { db } from "../db";
import { organizations, users, Organization, User } from "../db/schema";

export async function resolveOrganization(
  clerkOrgId: string,
  appId: string
): Promise<Organization> {
  const existing = await db
    .select()
    .from(organizations)
    .where(eq(organizations.clerkOrgId, clerkOrgId))
    .limit(1);

  if (existing.length > 0) {
    return existing[0];
  }

  const [created] = await db
    .insert(organizations)
    .values({ clerkOrgId, appId })
    .onConflictDoNothing({ target: organizations.clerkOrgId })
    .returning();

  if (created) {
    return created;
  }

  // Race condition: another request created it between our select and insert
  const [found] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.clerkOrgId, clerkOrgId))
    .limit(1);

  return found;
}

export async function resolveUser(
  clerkUserId: string,
  organizationId: string
): Promise<User> {
  const existing = await db
    .select()
    .from(users)
    .where(eq(users.clerkUserId, clerkUserId))
    .limit(1);

  if (existing.length > 0) {
    return existing[0];
  }

  const [created] = await db
    .insert(users)
    .values({ clerkUserId, organizationId })
    .onConflictDoNothing({ target: users.clerkUserId })
    .returning();

  if (created) {
    return created;
  }

  const [found] = await db
    .select()
    .from(users)
    .where(eq(users.clerkUserId, clerkUserId))
    .limit(1);

  return found;
}
