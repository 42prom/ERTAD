import { createProviderControl } from './modules/security/providerPolicy.js';
import pg from 'pg';
import { createClient } from 'redis';
import pino from 'pino';
import { createApp } from './app.js';
import { readConfig } from './config.js';
import { createNetworkControl } from './modules/security/networkControl.js';
import { startSecurityMailWorker } from './modules/identity/mailDelivery.js';
import { startNotificationDispatcher } from './services/notificationDispatcher.js';
import { attachRealtimeRedis, REALTIME_REDIS_CHANNEL } from './modules/communication/realtime.js';

const config = readConfig();
const localAdmin = process.env.ERTAD_LOCAL_ADMIN === 'true'
  ? (await import('./localAdmin.js')).createLocalAdminRouter(config.webOrigin)
  : undefined;
const localMobile = process.env.ERTAD_LOCAL_ADMIN === 'true'
  ? (await import('./modules/mobile/router.js')).createLocalMobileRouter(config.webOrigin)
  : undefined;
const logger = pino({ level: 'info' });
const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10, connectionTimeoutMillis: 1500, query_timeout: 1500, statement_timeout: 1500 });
pool.on('error', () => logger.error({ dependency: 'postgres' }, 'dependency unavailable'));
const redis = createClient({ url: config.redisUrl, disableOfflineQueue: true, socket: { connectTimeout: 1500, reconnectStrategy: retries => Math.min(retries * 200, 3000) } });
redis.on('error', () => logger.warn({ dependency: 'redis' }, 'dependency unavailable'));
const realtimeSubscriber = localAdmin ? redis.duplicate() : undefined;
if (realtimeSubscriber) {
  realtimeSubscriber.on('error', () => logger.warn({ dependency: 'redis-pubsub' }, 'dependency unavailable'));
  const onRealtimeMessage = attachRealtimeRedis((message) => {
    if (redis.isReady) void redis.publish(REALTIME_REDIS_CHANNEL, message).catch(() => {});
  });
  void realtimeSubscriber
    .connect()
    .then(() => realtimeSubscriber.subscribe(REALTIME_REDIS_CHANNEL, (message) => onRealtimeMessage(message)))
    .catch(() => logger.warn({ dependency: 'redis-pubsub' }, 'pubsub subscription deferred'));
}
void redis.connect().catch(() => logger.error({ dependency: 'redis' }, 'connection failed'));
const network = process.env.ERTAD_NETWORK_CONTROL === 'true' ? createNetworkControl(
  process.env.ERTAD_PROXY_SECRET!, process.env.ERTAD_NETWORK_IP_KEY!,
  async () => (await pool.query('SELECT ertad.current_network_policy() policy')).rows[0].policy,
  process.env.ERTAD_COUNTRY_HEADERS_VERIFIED === 'true',
) : undefined;
const app = createApp({
  postgres: async () => {
    const required = ['0001_foundation.sql', ...(localAdmin ? ['0002_local_admin.sql', '0003_scoped_membership.sql', '0004_governance_bootstrap.sql', '0005_membership_reviews.sql', '0006_unit_creation_reviews.sql', '0007_named_decisions.sql', '0008_decision_formats.sql', '0009_decision_authoring.sql', '0010_hierarchical_work.sql', '0011_work_oversight.sql', '0012_work_needs.sql', '0013_collective_funding.sql', '0014_contribution_points.sql', '0015_unified_inbox.sql', '0016_group_channels.sql', '0017_decision_inbox.sql', '0018_work_channels.sql', '0019_channel_restrictions.sql', '0020_moderation_inbox.sql', '0021_contribution_inbox.sql', '0022_work_evidence.sql', '0023_mobilization_rewards.sql', '0024_work_material_links.sql', '0025_work_material_files.sql', '0026_work_review_hierarchy.sql', '0027_work_events.sql', '0028_work_recognition.sql', '0029_work_editing.sql', '0030_member_directory.sql', '0031_platform_console.sql', '0032_platform_sessions.sql', '0033_platform_integrations.sql', '0034_session_policy.sql', '0035_network_policy.sql', '0036_security_limits.sql', '0037_provider_policy.sql', '0038_unit_lifecycle.sql', '0039_membership_lifecycle.sql', '0040_position_definitions.sql', '0041_position_retirement.sql', '0042_membership_suspension.sql', '0043_position_rollout.sql', '0044_position_catalogue_loading.sql', '0045_self_account_password.sql', '0046_admin_mfa_enrollment_state.sql', '0047_web_invitations.sql', '0048_web_account_recovery.sql', '0049_own_recovery_control.sql'] : [])];
    if(localAdmin) required.push('0050_mail_policy.sql','0051_mail_transports.sql','0052_security_mail_delivery.sql','0053_pending_contact_revocation.sql','0054_own_email_change.sql','0055_web_account_security.sql','0056_account_session_projection.sql','0057_query_performance.sql','0058_account_lifecycle_and_recovery.sql','0059_event_lifecycle_editing.sql','0060_decisions_complete.sql','0061_reporting_and_operations.sql','0062_configurable_privacy_floor.sql','0063_workspace_and_realtime.sql','0064_channels_rich_collaboration.sql','0065_events_rsvp_checkin.sql','0066_decisions_branching_and_receipts.sql','0067_collective_evidence_and_ledger.sql','0068_account_security_and_outbox.sql','0069_platform_telemetry_and_audit_verify.sql','0070_mobile_member_privacy_and_bridge.sql','0071_direct_messages_and_channel_kinds.sql','0072_mobile_m4_auth_biometric_governance.sql','0073_biometric_template_reauth.sql','0074_personal_referrals_and_points_rules.sql','0075_technical_integrations_and_member_channels.sql','0076_notification_outbox_dispatcher.sql','0077_member_profile_phone_and_verified_details.sql','0078_zero_trust_biometric_gate.sql','0079_member_encrypted_portrait.sql','0080_sovereign_flexible_biometric_policy.sql','0081_phase_a_security_and_contracts.sql');
    const result = await pool.query('SELECT version FROM ertad.schema_migrations WHERE version = ANY($1::text[])', [required]);
    if (result.rowCount !== required.length) throw new Error('Schema not ready');
  },
  redis: async () => { if (await redis.ping() !== 'PONG') throw new Error('Redis unavailable'); },
  storage: async () => {
    const result = await fetch(config.storageHealthUrl, { signal: AbortSignal.timeout(1500) });
    if (!result.ok) throw new Error('Storage unavailable');
  },
}, logger, config.webOrigin, localAdmin, network, localAdmin ? async () => (await pool.query('SELECT ertad.current_security_limits() policy')).rows[0].policy : undefined, localAdmin ? createProviderControl(async () => (await pool.query("SELECT ertad.current_provider_policy() policy")).rows[0].policy) : undefined, localMobile);
const server = app.listen(config.port, config.host, (error?: Error) => {
  if (error) { logger.error('API could not bind configured address'); process.exit(1); }
  logger.info({ port: config.port }, 'ERTAD foundation listening');
});
const stopMail=localAdmin?startSecurityMailWorker(()=>logger.warn('Security mail processing unavailable')):async()=>{};
const stopDispatcher=localAdmin?startNotificationDispatcher(15_000):()=>{};
let stopping = false;
const shutdown = () => {
  if (stopping) return;
  stopping = true;
  stopDispatcher();
  const deadline = setTimeout(() => process.exit(1), 10_000).unref();
  server.close(() => {
    void Promise.allSettled([
      pool.end(),
      ...(localAdmin ? [stopMail().then(()=>import('./db/client.js')).then(database => database.close())] : []),
      Promise.resolve().then(() => { if (redis.isOpen) redis.destroy(); }),
      Promise.resolve().then(() => { if (realtimeSubscriber?.isOpen) realtimeSubscriber.destroy(); }),
    ])
      .then(() => { clearTimeout(deadline); process.exit(0); });
  });
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
