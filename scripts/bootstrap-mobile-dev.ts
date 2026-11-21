import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import pg from 'pg';

loadEnvFile('.env');
if (process.env.NODE_ENV && process.env.NODE_ENV !== 'development') {
  throw new Error('Mobile dev bootstrap is local development only');
}
process.env.NODE_ENV = 'development';

const pgPort = Number(process.env.ERTAD_POSTGRES_PORT ?? 15432);
if (
  !Number.isInteger(pgPort) ||
  pgPort < 1024 ||
  pgPort > 65535 ||
  !process.env.POSTGRES_PASSWORD ||
  !process.env.APP_DB_PASSWORD ||
  !process.env.API_KEY_ENCRYPTION_SECRET
) {
  throw new Error('Initialize local infrastructure/admin first (npm run setup)');
}

process.env.DATABASE_URL = `postgresql://ertad_app:${encodeURIComponent(process.env.APP_DB_PASSWORD)}@127.0.0.1:${pgPort}/ertad`;

const { hashAdminPassword } = await import('../backend/src/services/adminPassword');
const { encryptSensitiveValue } = await import('../backend/src/services/secretEncryption');
const { generateMfaSecret } = await import('../backend/src/services/adminMfa');
const { createMobileBearerSession, revokeAdminSession, authenticateMobileBearerSession } =
  await import('../backend/src/services/adminSession');
const { decisionCommand } = await import('../backend/src/modules/decisions/polls');
const { workCommand } = await import('../backend/src/modules/work/tasks');
const { channelCommand } = await import('../backend/src/modules/communication/channels');
const { mobileDevFile, mobileDevSchema } = await import('../backend/src/modules/mobile/router');
const { SecurityService } = await import('../backend/src/services/security');
const { close: closeAppPool } = await import('../backend/src/db/client');

const client = new pg.Client({
  host: '127.0.0.1',
  port: pgPort,
  database: 'ertad',
  user: 'ertad_owner',
  password: process.env.POSTGRES_PASSWORD,
  options: '-c search_path=ertad,public',
});

await client.connect();

let managerCreds: { id: string; passwordHash: string; email: string } | null = null;
let orgId = '';
let groupUnitId = '';

try {
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(42420070)');

  const existing = await client.query(
    "SELECT id FROM admin_users WHERE email LIKE '%@mobile.ertad.local' LIMIT 1"
  );

  if (existing.rowCount && existsSync(mobileDevFile)) {
    const parsed = mobileDevSchema.parse(JSON.parse(readFileSync(mobileDevFile, 'utf8')));
    orgId = parsed.organizationId;
    groupUnitId = parsed.personas[0].unitId;
    const decCount = await client.query(
      "SELECT count(*)::int AS c FROM decisions WHERE organization_id=$1 AND status='open' AND closes_at > clock_timestamp()",
      [orgId]
    );
    const chCount = await client.query(
      "SELECT count(DISTINCT channel_kind)::int AS c FROM channels WHERE organization_id=$1 AND channel_kind IN ('global','group','task')",
      [orgId]
    );
    if (decCount.rows[0].c < 3 || chCount.rows[0].c < 3) {
      const mgr = parsed.personas.find((p) => p.roleKind === 'group_manager');
      if (mgr) {
        const u = (await client.query('SELECT id, email, password_hash FROM admin_users WHERE id=$1', [mgr.id])).rows[0];
        if (u) managerCreds = { id: u.id, email: u.email, passwordHash: u.password_hash };
      }
    }
    await client.query('COMMIT');
    console.log('Existing local mobile dev personas preserved.');
  } else {
    orgId = randomUUID();
    const rootUnitId = randomUUID();
    groupUnitId = randomUUID();

    await client.query("INSERT INTO organizations(id, name) VALUES($1, 'ERTAD · საბურთალო')", [
      orgId,
    ]);
    await client.query(
      "INSERT INTO units(organization_id, id, parent_id, name, kind) VALUES($1, $2, NULL, 'საბჭო', 'authority')",
      [orgId, rootUnitId]
    );
    await client.query(
      "INSERT INTO units(organization_id, id, parent_id, name, kind) VALUES($1, $2, $3, 'საბურთალოს ჯგუფი', 'authority')",
      [orgId, groupUnitId, rootUnitId]
    );

    const memberBundleId = randomUUID();
    const managerBundleId = randomUUID();

    const memberPermissions = [
      'unit.read',
      'workitem.read',
      'workitem.participate',
      'decision.read',
      'decision.vote',
      'channel.read',
      'channel.post',
      'contribution.read',
    ] as const;

    const managerPermissions = [
      ...memberPermissions,
      'member.read',
      'workitem.create',
      'workitem.verify',
      'channel.manage',
      'channel.moderate',
      'decision.manage',
      'decision.publish',
      'governance.propose',
      'governance.vote',
      'governance.manage',
      'finance.read',
      'finance.record',
      'finance.approve',
      'membership.propose',
      'membership.approve',
    ] as const;

    for (const [bundleId, perms] of [
      [memberBundleId, memberPermissions],
      [managerBundleId, managerPermissions],
    ] as const) {
      await client.query(
        'INSERT INTO permission_bundles(organization_id, id, version) VALUES($1, $2, 1)',
        [orgId, bundleId]
      );
      for (const perm of perms) {
        await client.query("INSERT INTO permission_grants VALUES($1, $2, 1, $3, 'unit')", [
          orgId,
          bundleId,
          perm,
        ]);
      }
      await client.query(
        "UPDATE permission_bundles SET status='approved' WHERE organization_id=$1 AND id=$2",
        [orgId, bundleId]
      );
    }

    const memberPosId = randomUUID();
    const managerPosId = randomUUID();
    await client.query(
      "INSERT INTO positions(organization_id, id, unit_id, name, bundle_id, bundle_version) VALUES($1, $2, $3, 'ჯგუფის წევრი', $4, 1)",
      [orgId, memberPosId, groupUnitId, memberBundleId]
    );
    await client.query(
      "INSERT INTO positions(organization_id, id, unit_id, name, bundle_id, bundle_version) VALUES($1, $2, $3, 'ჯგუფის მენეჯერი', $4, 1)",
      [orgId, managerPosId, groupUnitId, managerBundleId]
    );

    const personas: Array<{
      id: string;
      memberId: string;
      unitId: string;
      unitName: string;
      email: string;
      password: string;
      label: string;
      roleKind: 'member' | 'group_manager';
    }> = [];

    for (const spec of [
      {
        email: 'member@mobile.ertad.local',
        label: 'მარიამ ბერიძე (წევრი)',
        roleKind: 'member' as const,
        role: 'observer',
        posId: memberPosId,
      },
      {
        email: 'manager@mobile.ertad.local',
        label: 'გიორგი კალანდაძე (მენეჯერი)',
        roleKind: 'group_manager' as const,
        role: 'admin',
        posId: managerPosId,
      },
    ]) {
      const userId = randomUUID();
      const memberId = randomUUID();
      const password = randomBytes(24).toString('base64url');
      const passwordHash = await hashAdminPassword(password);
      await client.query(
        'INSERT INTO admin_users(id, email, password_hash, role, full_name, mfa_secret_encrypted) VALUES($1, $2, $3, $4, $5, $6)',
        [userId, spec.email, passwordHash, spec.role, spec.label, encryptSensitiveValue(generateMfaSecret())]
      );
      await client.query('INSERT INTO member_users(id, web_account_id) VALUES($1, $2)', [
        memberId,
        userId,
      ]);
      await client.query(
        "INSERT INTO memberships(organization_id, user_id, unit_id, position_id, bundle_version, valid_from, valid_until) VALUES($1, $2, $3, $4, 1, now() - interval '1 minute', now() + interval '180 days')",
        [orgId, memberId, groupUnitId, spec.posId]
      );
      if (spec.roleKind === 'group_manager') {
        managerCreds = { id: userId, passwordHash, email: spec.email };
      }
      personas.push({
        id: userId,
        memberId,
        unitId: groupUnitId,
        unitName: 'საბურთალოს ჯგუფი',
        email: spec.email,
        password,
        label: spec.label,
        roleKind: spec.roleKind,
      });
    }

    // Add 8 cohort member identities so anonymous k>=10 floor is naturally satisfied.
    for (let i = 1; i <= 8; i++) {
      const cohortMemberId = randomUUID();
      await client.query('INSERT INTO member_users(id) VALUES($1)', [cohortMemberId]);
      await client.query(
        "INSERT INTO memberships(organization_id, user_id, unit_id, position_id, bundle_version, valid_from, valid_until) VALUES($1, $2, $3, $4, 1, now() - interval '1 minute', now() + interval '180 days')",
        [orgId, cohortMemberId, groupUnitId, memberPosId]
      );
    }

    await SecurityService.logAuditEventInTransaction(client, 'LOCAL_MOBILE_DEV_SEEDED', {
      organizationId: orgId,
      unitId: groupUnitId,
      personas: personas.length,
    });

    mkdirSync('.local', { recursive: true });
    writeFileSync(
      mobileDevFile,
      `${JSON.stringify({ version: 1, organizationId: orgId, personas }, null, 2)}\n`,
      { mode: 0o600 }
    );
    await client.query('COMMIT');
    console.log('Seeded mobile dev org, group & 2 scoped personas (.local/mobile-dev-access.json).');
  }

  // Seed rich Georgian operational domain items via authentic SQL commands if manager was just created.
  if (managerCreds) {
    const issued = await createMobileBearerSession(
      managerCreds.id,
      managerCreds.passwordHash,
      managerCreds.email,
      'Mobile Seeder'
    );
    const session = await authenticateMobileBearerSession(issued.sessionToken);
    if (!session) throw new Error('Unable to authenticate seeded manager session');

    await client.query(
      "UPDATE admin_sessions SET step_up_expires_at = clock_timestamp() + interval '5 minutes' WHERE id = $1",
      [session.sessionId]
    );

    try {
      const closesAt = new Date(Date.now() + 72 * 3600_000).toISOString();
      const eventStart = new Date(Date.now() + 20 * 3600_000).toISOString();
      const eventEnd = new Date(Date.now() + 22 * 3600_000).toISOString();
      const q1Id = randomUUID();
      const q2Id = randomUUID();

      const ensureDecision = async (payload: Record<string, unknown>) => {
        const existingRow = (
          await client.query(
            'SELECT id, status, version FROM decisions WHERE organization_id=$1 AND title=$2 AND closes_at > clock_timestamp() ORDER BY created_at DESC LIMIT 1',
            [orgId, payload.title]
          )
        ).rows[0];
        if (existingRow) {
          if (existingRow.status === 'draft') {
            await decisionCommand(session, 'publish', {
              key: randomUUID(),
              organizationId: orgId,
              id: existingRow.id,
              version: existingRow.version,
            });
          }
          return;
        }
        const created = await decisionCommand(session, 'create', payload);
        await decisionCommand(session, 'publish', {
          key: randomUUID(),
          organizationId: orgId,
          id: created.id,
          version: 1,
        });
      };

      await ensureDecision({
        key: randomUUID(),
        organizationId: orgId,
        unitId: groupUnitId,
        kind: 'poll',
        privacy: 'anonymous',
        title: 'საბურთალოს ჯგუფის შეხვედრის დღის შერჩევა',
        description: 'ავირჩიოთ უახლოესი კვირის ოპტიმალური შეხვედრის დღე.',
        options: ['პარასკევი · 19:00', 'შაბათი · 14:00', 'კვირა · 16:00'],
        quorum: 30,
        closesAt,
        includedUnitIds: [groupUnitId],
      });

      await ensureDecision({
        key: randomUUID(),
        organizationId: orgId,
        unitId: groupUnitId,
        kind: 'referendum',
        privacy: 'named',
        title: 'უბნის კოორდინაციის წესდების განახლება',
        description: 'გადავიდეთ ყოველკვირეულ მორიგე კოორდინატორებზე.',
        options: ['Yes', 'No', 'Abstain'],
        referendumLabels: {
          yes: 'მხარს ვუჭერ',
          no: 'წინააღმდეგი ვარ',
          abstain: 'თავს ვიკავებ',
        },
        threshold: 60,
        quorum: 40,
        closesAt,
        includedUnitIds: [groupUnitId],
      });

      await ensureDecision({
        key: randomUUID(),
        organizationId: orgId,
        unitId: groupUnitId,
        kind: 'survey',
        privacy: 'anonymous',
        title: 'მოხალისეთა ჩართულობის მოკლე კითხვარი',
        description: 'პირობითი კითხვარი ჯგუფის რესურსების დასაგეგმად.',
        options: [],
        quorum: 20,
        closesAt,
        includedUnitIds: [groupUnitId],
        questions: [
          {
            id: q1Id,
            type: 'single_choice',
            title: 'შეგიძლიათ შაბათ-კვირას საველე აქტივობაში ჩართვა?',
            required: true,
            options: ['დიახ', 'მხოლოდ ონლაინ', 'ამ ეტაპზე ვერა'],
          },
          {
            id: q2Id,
            type: 'text',
            title: 'რომელ მიმართულებაში შეგიძლიათ დახმარება?',
            required: false,
            maxLength: 300,
            placeholder: 'მაგ: ლოჯისტიკა, დიზაინი, იურიდიული კონსულტაცია',
            visibleIf: { questionId: q1Id, equals: '0' },
          },
        ],
      });

      const workExists = await client.query(
        'SELECT 1 FROM work_items WHERE organization_id=$1 LIMIT 1',
        [orgId]
      );
      if (!workExists.rowCount) {
        await workCommand(session, 'create', {
          key: randomUUID(),
          organizationId: orgId,
          unitId: groupUnitId,
          title: 'საბურთალოს პარკის დასუფთავების ორგანიზება',
          description: 'საჭიროა 6 მოხალისე, ხელთათმანები და ინვენტარის ლოჯისტიკა.',
          roleLabel: 'მოხალისე კოორდინატორი',
          priority: 'high',
          capacity: 6,
          deadline: closesAt,
          contributionRuleId: null,
        });
      }

      const eventExists = await client.query(
        'SELECT 1 FROM mobilization_events WHERE organization_id=$1 LIMIT 1',
        [orgId]
      );
      if (!eventExists.rowCount) {
        await workCommand(session, 'event_create', {
          key: randomUUID(),
          organizationId: orgId,
          unitId: groupUnitId,
          title: 'ჯგუფის ღია სამუშაო შეხვედრა',
          description: 'საორგანიზაციო შეხვედრა და QR check-in.',
          location: 'საბურთალოს სივრცე · პეკინის 24',
          startsAt: eventStart,
          endsAt: eventEnd,
          capacityLimit: 25,
          contributionRuleId: null,
        });
      }

      const groupChExists = await client.query(
        "SELECT id FROM channels WHERE organization_id=$1 AND channel_kind='group' LIMIT 1",
        [orgId]
      );
      if (!groupChExists.rowCount) {
        const ch = await channelCommand(session, 'create', {
          key: randomUUID(),
          organizationId: orgId,
          unitId: groupUnitId,
          title: 'საბურთალოს ჯგუფი · სამუშაო ჩათი',
          kind: 'group',
        });
        const msg = await channelCommand(session, 'post', {
          key: randomUUID(),
          organizationId: orgId,
          id: ch.id,
          body: 'მოგესალმებით ჯგუფის არხში! გთხოვთ გადახედოთ გახსნილ კენჭისყრას და შაბათის შეხვედრას.',
        });
        if (msg?.messageId) {
          await channelCommand(session, 'pin', {
            key: randomUUID(),
            organizationId: orgId,
            id: ch.id,
            messageId: msg.messageId,
          });
        }
      }

      const globalChExists = await client.query(
        "SELECT id FROM channels WHERE organization_id=$1 AND channel_kind='global' LIMIT 1",
        [orgId]
      );
      if (!globalChExists.rowCount) {
        const gch = await channelCommand(session, 'create', {
          key: randomUUID(),
          organizationId: orgId,
          unitId: groupUnitId,
          title: 'საერთო განცხადებები',
          kind: 'global',
        });
        await channelCommand(session, 'post', {
          key: randomUUID(),
          organizationId: orgId,
          id: gch.id,
          body: 'მიმდინარე კვირაში ტარდება საბურთალოს ჯგუფის ღია სამუშაო შეხვედრა და პარკის მოხალისეობრივი აქცია.',
        });
      }

      const openWorkRow = (
        await client.query(
          "SELECT id FROM work_items WHERE organization_id=$1 AND status='open' ORDER BY created_at ASC LIMIT 1",
          [orgId]
        )
      ).rows[0];
      if (openWorkRow) {
        const taskChExists = await client.query(
          'SELECT id FROM channels WHERE organization_id=$1 AND work_id=$2 LIMIT 1',
          [orgId, openWorkRow.id]
        );
        if (!taskChExists.rowCount) {
          const tch = await channelCommand(session, 'work-create', {
            key: randomUUID(),
            organizationId: orgId,
            workId: openWorkRow.id,
          });
          await channelCommand(session, 'post', {
            key: randomUUID(),
            organizationId: orgId,
            id: tch.id,
            body: 'დავალების კოორდინაციის ჩათი გაიხსნა — აქ შევათანხმებთ დროს და ინვენტარს.',
          });
        }
      }
      console.log('Seeded live decisions (poll/referendum/survey), task, 48h event, and channel.');
    } finally {
      await revokeAdminSession(session.sessionId);
    }
  }
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  throw error;
} finally {
  await client.end();
  await closeAppPool();
}
