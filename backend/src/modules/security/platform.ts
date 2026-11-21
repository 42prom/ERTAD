import { createHash } from 'node:crypto';
import { providerProposalSchema, protectProviderInput } from './providerPolicy';
import { createAccountSecurityRouter } from './accountSecurity';
import { mailProposalSchema, protectMailInput, validateMailConfiguration } from './mailPolicy';
import { query } from '../../db/client';
import { securityLimitsValues } from './securityLimits';
import { Router } from 'express';
import { z } from 'zod';
import { retryDeadlockedTransaction } from '../../db/client';
import { requireAdmin } from '../../middleware/auth';
import { requireAdminCsrf } from '../../middleware/adminAuthorization';
import { SecurityService } from '../../services/security';
import type { AdminSessionIdentity } from '../../services/adminSession';
import { ReviewError } from '../governance/reviews';
import type { DependencyChecks } from '../../app';
import { diagnosticTargets, diagnoseIntegration, integrationInventory } from './integrations';
import { rateLimit } from 'express-rate-limit';
import { adminSessionPolicy } from '../../services/adminSession';
import { SecurityTelemetry, securitySignals } from './telemetry';
import { networkSettingsSchema, type NetworkControl } from './networkControl';
import { signAuditCheckpoint } from '../../services/auditCheckpoint';
import { createVerificationGovernanceRouter } from './verificationPolicy';

const schemas = {
  mailPolicy: z.object({ before: z.string().uuid().optional() }).strict(),
  proposeMailPolicy: mailProposalSchema,
  reviewMailPolicy: z.object({ requestId: z.string().uuid(), proposalId: z.string().uuid(), action: z.enum(['approve','reject','withdraw']) }).strict(),
  mailCheck: z.object({ expectedVersion: z.number().int().min(0).max(2147483646), status: z.enum(['requested','valid','unavailable','off']) }).strict(),
  providerPolicy: z.object({ before: z.string().uuid().optional() }).strict(),
  proposeProviderPolicy: providerProposalSchema,
  reviewProviderPolicy: z.object({requestId:z.string().uuid(),proposalId:z.string().uuid(),action:z.enum(['approve','reject','withdraw']),runtimeReady:z.boolean()}).strict(),
  securityLimits: z.object({ before: z.string().uuid().optional() }).strict(),
  proposeSecurityLimits: z.object({ requestId: z.string().uuid(), expectedVersion: z.number().int().min(0).max(2147483646),
    ...securityLimitsValues, reason: z.enum(['security_tightening','traffic_adjustment','recovery']) }).strict(),
  reviewSecurityLimits: z.object({ requestId: z.string().uuid(), proposalId: z.string().uuid(), action: z.enum(['approve','reject','withdraw']) }).strict(),
  networkPolicy: z.object({ before: z.string().uuid().optional() }).strict(),
  proposeNetworkPolicy: z.object({
    requestId: z.string().uuid(), expectedVersion: z.number().int().min(0).max(2147483646),
    settings: networkSettingsSchema, reason: z.enum(['security_tightening', 'network_access', 'recovery']),
  }).strict(),
  reviewNetworkPolicy: z.object({ requestId: z.string().uuid(), proposalId: z.string().uuid(), action: z.enum(['approve','reject','withdraw']),
    countryReady: z.boolean(), source: z.object({ country: z.string().regex(/^[A-Z]{2}$|^T1$/), key: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
  }).strict(),
  sessionPolicy: z.object({ before: z.string().uuid().optional() }).strict(),
  proposeSessionPolicy: z
    .object({
      requestId: z.string().uuid(),
      expectedVersion: z.number().int().min(0).max(2147483646),
      idleSeconds: z.number().int().min(300).max(3600),
      absoluteSeconds: z.number().int().min(900).max(86400),
      maxSessions: z.number().int().min(1).max(10),
      reason: z.enum(['security_tightening', 'session_usability', 'recovery']),
    })
    .strict()
    .refine((v) => v.idleSeconds <= v.absoluteSeconds),
  reviewSessionPolicy: z
    .object({
      requestId: z.string().uuid(),
      proposalId: z.string().uuid(),
      action: z.enum(['approve', 'reject', 'withdraw']),
    })
    .strict(),
  access: z.object({}).strict(),
  overview: z.object({}).strict(),
  integrations: z.object({}).strict(),
  integrationCheck: z
    .object({
      target: z.enum(diagnosticTargets),
      status: z.enum(['requested', 'ready', 'unavailable', 'not_configured']),
    })
    .strict(),
  sessions: z
    .object({
      before: z.string().uuid().optional(),
      kind: z.enum(['all', 'technical', 'organization', 'unclassified']).default('all'),
    })
    .strict(),
  revoke: z
    .object({
      sessionId: z.string().uuid(),
      requestId: z.string().uuid(),
      reason: z.enum(['suspected_compromise', 'operator_request', 'session_hygiene']),
    })
    .strict(),
  audit: z
    .object({
      before: z
        .string()
        .regex(/^[1-9]\d{0,18}$/)
        .refine((v) => BigInt(v) <= 9223372036854775807n)
        .optional(),
      category: z.enum(['all', 'access', 'authentication']).default('all'),
    })
    .strict(),
};
export async function platformCommand(
  session: Pick<AdminSessionIdentity, 'sessionId' | 'sessionTokenHash'>,
  operation: keyof typeof schemas,
  input: unknown
) {
  const parsed = schemas[operation].safeParse(input);
  if (!parsed.success) throw new ReviewError(400, 'INVALID_REQUEST');
  const commandInput = operation === 'proposeMailPolicy' ? protectMailInput(mailProposalSchema.parse(parsed.data)) : operation === 'proposeProviderPolicy' ? protectProviderInput(providerProposalSchema.parse(parsed.data)) : parsed.data;
  try {
    return await retryDeadlockedTransaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      const functionName = ['mailPolicy','proposeMailPolicy','reviewMailPolicy','mailCheck'].includes(operation) ? 'mail_policy_command' : ['providerPolicy','proposeProviderPolicy','reviewProviderPolicy'].includes(operation) ? 'provider_policy_command' : ['securityLimits','proposeSecurityLimits','reviewSecurityLimits'].includes(operation) ? 'security_limits_command' : ['networkPolicy','proposeNetworkPolicy','reviewNetworkPolicy'].includes(operation) ? 'network_policy_command' :
        operation === 'sessionPolicy' ||
        operation === 'proposeSessionPolicy' ||
        operation === 'reviewSessionPolicy'
          ? 'session_policy_command'
          : operation === 'sessions' || operation === 'revoke'
            ? 'platform_session_command'
            : operation === 'integrations' || operation === 'integrationCheck'
              ? 'platform_integration_command'
              : 'platform_console_command';
      const read = async () =>
        (
          await client.query(`SELECT ertad.${functionName}($1,$2,$3,$4) result`, [
            session.sessionId,
            session.sessionTokenHash,
            operation,
            JSON.stringify(commandInput),
          ])
        ).rows[0].result;
      const first = await read();
      if (first.audit)
        await SecurityService.logAuditEventInTransaction(
          client,
          operation === 'mailPolicy' ? 'PLATFORM_MAIL_POLICY_READ' :
          operation === 'proposeMailPolicy' ? 'PLATFORM_MAIL_POLICY_PROPOSED' :
          operation === 'reviewMailPolicy' ? 'PLATFORM_MAIL_POLICY_REVIEWED' :
          operation === 'mailCheck' ? 'PLATFORM_MAIL_CHECK' :
          operation === 'providerPolicy' ? 'PLATFORM_PROVIDER_POLICY_READ' :
          operation === 'proposeProviderPolicy' ? 'PLATFORM_PROVIDER_POLICY_PROPOSED' :
          operation === 'reviewProviderPolicy' ? 'PLATFORM_PROVIDER_POLICY_REVIEWED' :
          operation === 'securityLimits' ? 'PLATFORM_SECURITY_LIMITS_READ' :
          operation === 'proposeSecurityLimits' ? 'PLATFORM_SECURITY_LIMITS_PROPOSED' :
          operation === 'reviewSecurityLimits' ? 'PLATFORM_SECURITY_LIMITS_REVIEWED' :
          operation === 'proposeNetworkPolicy' ? 'PLATFORM_NETWORK_POLICY_PROPOSED' :
          operation === 'reviewNetworkPolicy' ? 'PLATFORM_NETWORK_POLICY_REVIEWED' :
          operation === 'networkPolicy' ? 'PLATFORM_NETWORK_POLICY_READ' :
          operation === 'proposeSessionPolicy'
            ? 'PLATFORM_SESSION_POLICY_PROPOSED'
            : operation === 'reviewSessionPolicy'
              ? 'PLATFORM_SESSION_POLICY_REVIEWED'
              : operation === 'sessionPolicy'
                ? 'PLATFORM_SESSION_POLICY_READ'
                : operation === 'integrationCheck'
                  ? 'PLATFORM_INTEGRATION_CHECK'
                  : operation === 'revoke'
                    ? 'PLATFORM_SESSION_REVOKED'
                    : `PLATFORM_${operation.toUpperCase()}_READ`,
          first.audit
        );
      // Reads recheck disclosure after audit. A response retry returns its receipt,
      // revalidating live authority/step-up without repeating the mutation or audit.
      return (await read()).data;
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === '42501') throw new ReviewError(403, 'ACCESS_DENIED');
    if (code === 'P0428') throw new ReviewError(428, 'ADMIN_STEP_UP_REQUIRED');
    const policyOperation = [
      'mailPolicy','proposeMailPolicy','reviewMailPolicy','mailCheck',
      'providerPolicy','proposeProviderPolicy','reviewProviderPolicy',
      'securityLimits', 'proposeSecurityLimits', 'reviewSecurityLimits',
        'networkPolicy', 'proposeNetworkPolicy', 'reviewNetworkPolicy',
      'sessionPolicy',
      'proposeSessionPolicy',
      'reviewSessionPolicy',
    ].includes(operation);
    if (code === 'P0409' || (policyOperation && code === '23505'))
      throw new ReviewError(409, policyOperation ? 'POLICY_CONFLICT' : 'SESSION_CONFLICT');
    if (code === 'P0404')
      throw new ReviewError(404, policyOperation ? 'POLICY_UNAVAILABLE' : 'SESSION_UNAVAILABLE');
    if (['22023', '22P02', '22003', '23514'].includes(code ?? ''))
      throw new ReviewError(400, 'INVALID_REQUEST');
    throw error;
  }
}
export async function platformDependencies(checks?: DependencyChecks) {
  const entries = await Promise.all(
    (['postgres', 'redis', 'storage'] as const).map(async (name) => {
      if (!checks?.[name]) return [name, 'unavailable'];
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.resolve().then(checks[name]),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('timeout')), 2000);
          }),
        ]);
        return [name, 'ready'];
      } catch {
        return [name, 'unavailable'];
      } finally {
        clearTimeout(timer);
      }
    })
  );
  return Object.fromEntries(entries) as Record<keyof DependencyChecks, 'ready' | 'unavailable'>;
}
export function createPlatformRouter() {
  const router = Router();
  router.use(requireAdmin);
  router.use('/accounts',createAccountSecurityRouter());
  router.use('/verification', createVerificationGovernanceRouter());
  router.get('/mail-policy', async(req,res,next)=>{
    try { res.set('Cache-Control','no-store').json(await platformCommand(req.adminSession!,'mailPolicy',req.query)); } catch(error) { next(error); }
  });
  for (const [path, operation] of [['propose','proposeMailPolicy'],['review','reviewMailPolicy']] as const)
    router.post('/mail-policy/'+path, requireAdminCsrf, async(req,res,next)=>{
      try { res.set('Cache-Control','no-store').json(await platformCommand(req.adminSession!,operation,req.body)); } catch(error) { next(error); }
    });
  router.post('/mail-policy/check', requireAdminCsrf, rateLimit({ windowMs: 60_000, limit: 3, standardHeaders: 'draft-7', legacyHeaders: false }), async(req,res,next)=>{
    try {
      const input=z.object({ expectedVersion:z.number().int().min(0).max(2147483646) }).strict().parse(req.body);
      await platformCommand(req.adminSession!,'mailCheck',{...input,status:'requested'});
      const policy=(await query('SELECT ertad.current_mail_policy() policy')).rows[0].policy;
      if (policy.version !== input.expectedVersion) throw new ReviewError(409,'POLICY_CONFLICT');
      const status=await validateMailConfiguration(policy);
      res.set('Cache-Control','no-store').json(await platformCommand(req.adminSession!,'mailCheck',{...input,status}));
    } catch(error) { next(error instanceof z.ZodError ? new ReviewError(400,'INVALID_REQUEST') : error); }
  });
  router.get('/provider-policy', async(req,res,next)=>{
    try { res.set('Cache-Control','no-store').json({...await platformCommand(req.adminSession!,'providerPolicy',req.query),
      runtimeReady: !!req.app.locals.providerControl && !!req.app.locals.networkControl }); } catch(error){next(error);}
  });
  router.post('/provider-policy/propose',requireAdminCsrf,async(req,res,next)=>{
    try {res.set('Cache-Control','no-store').json(await platformCommand(req.adminSession!,'proposeProviderPolicy',req.body));}catch(error){next(error);}
  });
  router.post('/provider-policy/review',requireAdminCsrf,async(req,res,next)=>{
    try {
      const input=z.object({requestId:z.string().uuid(),proposalId:z.string().uuid(),action:z.enum(['approve','reject','withdraw'])}).strict().parse(req.body);
      res.set('Cache-Control','no-store').json(await platformCommand(req.adminSession!,'reviewProviderPolicy',{...input,
        runtimeReady:!!req.app.locals.providerControl && !!req.app.locals.networkControl}));
    }catch(error){next(error instanceof z.ZodError ? new ReviewError(400,'INVALID_REQUEST') : error);}
  });
  router.get('/security-limits', async (req,res,next) => {
    try { res.set('Cache-Control','no-store').json(await platformCommand(req.adminSession!, 'securityLimits', req.query)); }
    catch(error) { next(error); }
  });
  for (const [path,operation] of [['propose','proposeSecurityLimits'],['review','reviewSecurityLimits']] as const)
    router.post('/security-limits/'+path,requireAdminCsrf,async(req,res,next)=>{
      try { res.set('Cache-Control','no-store').json(await platformCommand(req.adminSession!,operation,req.body)); }
      catch(error) { next(error); }
    });
  router.get('/network-policy', async (req, res, next) => {
    try {
      const data = await platformCommand(req.adminSession!, 'networkPolicy', req.query);
      const control = req.app.locals.networkControl as NetworkControl | undefined;
      res.set('Cache-Control','no-store').json({ ...data, configured: !!control,
        countryReady: control?.countryReady ?? false, source: res.locals.networkSource ?? 'unverified', country: res.locals.networkCountry ?? null });
    } catch (error) { next(error); }
  });
  router.post('/network-policy/address-key', requireAdminCsrf, async (req, res, next) => {
    try {
      const input = z.object({ address: z.string().min(2).max(45) }).strict().safeParse(req.body);
      if (!input.success) throw new ReviewError(400,'INVALID_REQUEST');
      await platformCommand(req.adminSession!, 'networkPolicy', {});
      const control = req.app.locals.networkControl as NetworkControl | undefined;
      if (!control) throw new ReviewError(409,'NETWORK_NOT_CONFIGURED');
      let key: string;
      try { key = control.key(input.data.address); } catch { throw new ReviewError(400,'INVALID_ADDRESS'); }
      res.set('Cache-Control','no-store').json({ key });
    } catch (error) { next(error); }
  });
  for (const [path, operation] of [['propose','proposeNetworkPolicy'],['review','reviewNetworkPolicy']] as const)
    router.post('/network-policy/' + path, requireAdminCsrf, async (req, res, next) => {
      try {
        const control = req.app.locals.networkControl as NetworkControl | undefined;
        if (!control) throw new ReviewError(409,'NETWORK_NOT_CONFIGURED');
        const body = operation === 'reviewNetworkPolicy' ? { ...req.body, countryReady: control.countryReady,
          source: res.locals.networkSource === 'cloudflare' ? { country: res.locals.networkCountry, key: res.locals.networkAddressKey } : undefined } : req.body;
        res.set('Cache-Control','no-store').json(await platformCommand(req.adminSession!, operation, body));
      } catch (error) { next(error); }
    });
  router.get('/monitoring', async (req, res, next) => {
    try {
      const parsed = z
        .object({
          minutes: z.enum(['15', '60', '1440']).default('15'),
          category: z.enum(['all', ...securitySignals]).default('all'),
        })
        .strict()
        .safeParse(req.query);
      if (!parsed.success) throw new ReviewError(400, 'INVALID_REQUEST');
      const telemetry = req.app.locals.securityTelemetry;
      if (!(telemetry instanceof SecurityTelemetry)) throw new Error('Monitoring unavailable');
      await telemetry.flush(query).catch(() => {});
      // Reuse the audited technical-journal authority and post-audit recheck.
      // This supplies only the existing sanitized authentication projection.
      const journal = await platformCommand(req.adminSession!, 'audit', {
        category: 'authentication',
      });
      const win = Number(parsed.data.minutes) as 15 | 60 | 1440;
      const snapshot =
        win === 1440
          ? await telemetry.persistedSnapshot(
              query,
              req.adminSession!.sessionId,
              req.adminSession!.sessionTokenHash,
              1440,
              parsed.data.category
            )
          : telemetry.snapshot(win, parsed.data.category);
      res.set('Cache-Control', 'no-store').json({
        ...snapshot,
        recentTechnicalEvents: journal.items.slice(0, 5),
      });
    } catch (error) {
      next(error);
    }
  });
  router.get('/metrics', async (req, res, next) => {
    try {
      await platformCommand(req.adminSession!, 'audit', { category: 'all' });
      const telemetry = req.app.locals.securityTelemetry;
      if (!(telemetry instanceof SecurityTelemetry)) throw new Error('Metrics unavailable');
      await telemetry.flush(query);
      const body = await telemetry.metricsText();
      res
        .set('Cache-Control', 'no-store')
        .set('Content-Type', telemetry.metricsContentType)
        .send(body);
    } catch (error) {
      next(error);
    }
  });
  router.get('/audit/verify', async (req, res, next) => {
    try {
      await platformCommand(req.adminSession!, 'audit', { category: 'all' });
      let afterId = 0;
      let expectedPrevHash = '0'.repeat(64);
      let verifiedCount = 0;
      let genesisId: string | null = null;
      let headId: string | null = null;
      let headHash = expectedPrevHash;
      let unbroken = true;
      let brokenId: string | null = null;

      while (true) {
        const slice = (
          await query('SELECT ertad.read_audit_chain_slice($1,$2,$3,$4) AS r', [
            req.adminSession!.sessionId,
            req.adminSession!.sessionTokenHash,
            afterId,
            2000,
          ])
        ).rows[0]?.r as {
          previous: { id: string; rowHash: string } | null;
          rows: {
            id: string;
            eventType: string;
            payload: string;
            previousHash: string;
            rowHash: string;
            createdAt: string;
          }[];
        };
        if (!slice?.rows?.length) break;
        if (afterId === 0 && slice.previous) expectedPrevHash = slice.previous.rowHash;
        for (const row of slice.rows) {
          if (!genesisId) genesisId = row.id;
          const recomputed = createHash('sha256')
            .update(`${row.eventType}|${row.payload}|${row.previousHash}|${row.createdAt}`)
            .digest('hex');
          if (row.previousHash !== expectedPrevHash || row.rowHash !== recomputed) {
            unbroken = false;
            brokenId = row.id;
            break;
          }
          verifiedCount++;
          headId = row.id;
          headHash = row.rowHash;
          expectedPrevHash = row.rowHash;
          afterId = Number(row.id);
        }
        if (!unbroken || slice.rows.length < 2000) break;
      }

      const checkedAt = new Date().toISOString();
      const deploymentId = process.env.AUDIT_CHECKPOINT_DEPLOYMENT_ID?.trim() || 'ertad-local';
      let signedCheckpoint: ReturnType<typeof signAuditCheckpoint> | null = null;
      if (headId && process.env.AUDIT_CHECKPOINT_PRIVATE_KEY_PEM && process.env.AUDIT_CHECKPOINT_PUBLIC_KEY_PEM) {
        try {
          signedCheckpoint = signAuditCheckpoint({
            version: 1,
            deploymentId,
            auditId: headId,
            auditRowHash: headHash,
            previousCheckpointHash: '0'.repeat(64),
            createdAt: checkedAt,
          });
        } catch {
          signedCheckpoint = null;
        }
      }
      const manifestDigest = createHash('sha256')
        .update(`${deploymentId}:${genesisId ?? '0'}:${headId ?? '0'}:${headHash}:${verifiedCount}:${unbroken}`)
        .digest('hex');

      res.set('Cache-Control', 'no-store').json({
        verifiedCount,
        genesisId,
        headId,
        headHash,
        unbroken,
        brokenId,
        checkedAt,
        manifestDigest,
        signedCheckpoint,
      });
    } catch (error) {
      next(error);
    }
  });
  router.get('/session-policy', async (req, res, next) => {
    try {
      const data = await platformCommand(req.adminSession!, 'sessionPolicy', req.query);
      res.set('Cache-Control', 'no-store').json({
        ...data,
        current: data.current ?? {
          version: 0,
          idleSeconds: Math.min(
            adminSessionPolicy.idleTimeoutSeconds,
            adminSessionPolicy.absoluteTimeoutSeconds
          ),
          absoluteSeconds: adminSessionPolicy.absoluteTimeoutSeconds,
          maxSessions: adminSessionPolicy.maxConcurrentSessions,
        },
      });
    } catch (error) {
      next(error);
    }
  });
  for (const [path, operation] of [
    ['propose', 'proposeSessionPolicy'],
    ['review', 'reviewSessionPolicy'],
  ] as const)
    router.post('/session-policy/' + path, requireAdminCsrf, async (req, res, next) => {
      try {
        res
          .set('Cache-Control', 'no-store')
          .json(await platformCommand(req.adminSession!, operation, req.body));
      } catch (error) {
        next(error);
      }
    });
  router.post(
    '/integrations/check',
    requireAdminCsrf,
    rateLimit({
      windowMs: 60000,
      limit: 12,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      handler: (_req, res) => res.status(429).json({ error: { code: 'RATE_LIMITED' } }),
    }),
    async (req, res, next) => {
      try {
        const parsed = z
          .object({ target: z.enum(diagnosticTargets) })
          .strict()
          .safeParse(req.body);
        if (!parsed.success) throw new ReviewError(400, 'INVALID_REQUEST');
        await platformCommand(req.adminSession!, 'integrationCheck', {
          ...parsed.data,
          status: 'requested',
        });
        const result = await diagnoseIntegration(
          parsed.data.target,
          req.app.locals.dependencyChecks
        );
        await platformCommand(req.adminSession!, 'integrationCheck', {
          target: result.target,
          status: result.status,
        });
        res.set('Cache-Control', 'no-store').json(result);
      } catch (error) {
        next(error);
      }
    }
  );
  router.post('/sessions/revoke', requireAdminCsrf, async (req, res, next) => {
    try {
      res
        .set('Cache-Control', 'no-store')
        .json(await platformCommand(req.adminSession!, 'revoke', req.body));
    } catch (error) {
      next(error);
    }
  });
  for (const operation of Object.keys(schemas) as (keyof typeof schemas)[])
    if (
      ![
        'mailPolicy','proposeMailPolicy','reviewMailPolicy','mailCheck',
        'providerPolicy','proposeProviderPolicy','reviewProviderPolicy',
        'revoke',
        'integrationCheck',
        'sessionPolicy',
        'proposeSessionPolicy',
        'reviewSessionPolicy',
        'securityLimits', 'proposeSecurityLimits', 'reviewSecurityLimits',
        'networkPolicy', 'proposeNetworkPolicy', 'reviewNetworkPolicy',
      ].includes(operation)
    )
      router.get('/' + operation, async (req, res, next) => {
        try {
          const initial = await platformCommand(req.adminSession!, operation, req.query);
          if (operation === 'integrations') {
            res
              .set('Cache-Control', 'no-store')
              .json({ ...initial, items: integrationInventory(req.app.locals.dependencyChecks) });
            return;
          }
          if (operation !== 'overview') {
            res.set('Cache-Control', 'no-store').json(initial);
            return;
          }
          // Never probe dependencies for unauthorized callers; never disclose a stale grant after a slow probe.
          const dependencies = await platformDependencies(
            req.app.locals.dependencyChecks as DependencyChecks | undefined
          );
          const current = await platformCommand(req.adminSession!, operation, req.query);
          res.set('Cache-Control', 'no-store').json({
            ...current,
            dependencies,
            mode: process.env.NODE_ENV,
            productionEnabled: false,
            webMfa: 'release_gate',
            externalCheckpoint: 'not_activated',
          });
        } catch (error) {
          next(error);
        }
      });
  return router;
}
