/**
 * Audit Export Service
 *
 * Provides secure, streamed CSV export of election/poll audit data.
 * Features:
 * - Memory-efficient streaming for large datasets
 * - SHA-256 dataset checksum (not independent authenticity proof)
 * - Excel-compatible CSV format with BOM
 * - Sanitized and normalized values
 * - Extensible architecture for future formats
 */

import { pool } from '../db/client';
import crypto from 'crypto';
import { Readable } from 'stream';

export interface AuditExportOptions {
  pollId: string;
  includeVoteLevelData: boolean;
  anonymizeVoters: boolean;
  dateRangeStart?: Date;
  dateRangeEnd?: Date;
  adminUserId: string;
  adminEmail: string;
}

export interface PollMetadata {
  id: string;
  title: string;
  description: string | null;
  type: string;
  status: string;
  start_at: Date | null;
  end_at: Date | null;
  created_at: Date;
  published_at: Date | null;
  min_k_anonymity: number;
  audience_rules: any;
}

export interface ExportManifest {
  exportId: string;
  generatedAt: string;
  generatedBy: {
    userId: string;
    email: string;
  };
  poll: {
    id: string;
    title: string;
    type: string;
    status: string;
    startAt: string | null;
    endAt: string | null;
  };
  dataScope: {
    includesVoteLevelData: boolean;
    votersAnonymized: boolean;
    dateRangeStart: string | null;
    dateRangeEnd: string | null;
  };
  statistics: {
    totalVotes: number;
    totalParticipants: number;
    optionsCount: number;
  };
  integrityHash: string;
  hashAlgorithm: string;
}

/**
 * Escape CSV field for Excel compatibility
 */
function escapeCsvField(field: any): string {
  if (field === null || field === undefined) {
    return '';
  }

  const stringValue = String(field);

  // If field contains comma, newline, quotes, or starts with special chars, wrap in quotes
  if (
    stringValue.includes(',') ||
    stringValue.includes('\n') ||
    stringValue.includes('\r') ||
    stringValue.includes('"') ||
    stringValue.startsWith('=') ||
    stringValue.startsWith('+') ||
    stringValue.startsWith('-') ||
    stringValue.startsWith('@')
  ) {
    // Escape formula injection by prefixing with single quote (Excel standard)
    let escaped = stringValue;
    if (/^[=+\-@]/.test(escaped)) {
      escaped = "'" + escaped;
    }
    return `"${escaped.replace(/"/g, '""')}"`;
  }

  return stringValue;
}

/**
 * Format ISO timestamp for Excel compatibility
 */
function formatTimestamp(date: Date | null): string {
  if (!date) return '';
  return date.toISOString().replace('T', ' ').replace('Z', ' UTC');
}

/**
 * Generate unique export ID
 */
function generateExportId(): string {
  return `AUDIT-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

/**
 * Create CSV row from array of values
 */
function createCsvRow(values: any[]): string {
  return values.map(escapeCsvField).join(',') + '\r\n';
}

/**
 * Audit Export Service Class
 */
export class AuditExportService {
  private hashStream: crypto.Hash;
  private exportId: string;

  constructor() {
    this.hashStream = crypto.createHash('sha256');
    this.exportId = generateExportId();
  }

  /**
   * Validate poll can be exported (must be ended)
   */
  async validatePoll(pollId: string): Promise<PollMetadata> {
    const result = await pool.query(
      `SELECT
        id, title, description, type, status,
        start_at, end_at, created_at, published_at,
        min_k_anonymity, audience_rules
       FROM polls WHERE id = $1`,
      [pollId]
    );

    if (result.rows.length === 0) {
      throw new Error('Poll not found');
    }

    const poll = result.rows[0];

    if (poll.status !== 'ended' && poll.status !== 'archived') {
      throw new Error(`Cannot export poll with status '${poll.status}'. Only ended or archived polls can be exported.`);
    }

    return poll;
  }

  /**
   * Log export action for audit trail
   */
  async logExport(options: AuditExportOptions, poll: PollMetadata): Promise<void> {
    // Note: user_id FK references 'users' table but admin users are in 'admin_users' table
    // Always pass NULL for user_id and store admin info in meta JSONB instead
    await pool.query(
      `INSERT INTO security_events
       (event_type, result, user_id, ip_address, user_agent, meta, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [
        'audit_export',
        'success',
        null, // Admin users are in admin_users table, not users table
        '0.0.0.0', // IP should be passed from request
        'Admin Panel',
        JSON.stringify({
          exportId: this.exportId,
          pollId: options.pollId,
          pollTitle: poll.title,
          adminUserId: options.adminUserId,
          adminEmail: options.adminEmail,
          includeVoteLevelData: options.includeVoteLevelData,
          anonymizeVoters: options.anonymizeVoters,
          dateRangeStart: options.dateRangeStart?.toISOString() || null,
          dateRangeEnd: options.dateRangeEnd?.toISOString() || null,
        }),
      ]
    );
  }

  /**
   * Get poll options
   */
  async getOptions(pollId: string): Promise<any[]> {
    const result = await pool.query(
      `SELECT id, text, display_order FROM poll_options WHERE poll_id = $1 ORDER BY display_order`,
      [pollId]
    );
    return result.rows;
  }

  /**
   * Get aggregated results
   */
  async getAggregatedResults(pollId: string): Promise<any[]> {
    const result = await pool.query(
      `SELECT
        po.id as option_id,
        po.text as option_text,
        po.display_order,
        COUNT(v.id) as vote_count
       FROM poll_options po
       LEFT JOIN votes v ON v.option_id = po.id AND v.poll_id = $1
       WHERE po.poll_id = $1
       GROUP BY po.id, po.text, po.display_order
       ORDER BY po.display_order`,
      [pollId]
    );
    return result.rows;
  }

  /**
   * Get total vote count
   */
  async getTotalVotes(pollId: string): Promise<number> {
    const result = await pool.query(
      `SELECT COUNT(*) as count FROM votes WHERE poll_id = $1`,
      [pollId]
    );
    return parseInt(result.rows[0].count, 10);
  }

  /**
   * Get participant count
   */
  async getParticipantCount(pollId: string): Promise<number> {
    const result = await pool.query(
      `SELECT COUNT(*) as count FROM poll_participants WHERE poll_id = $1`,
      [pollId]
    );
    return parseInt(result.rows[0].count, 10);
  }

  private assertPrivacySafeExport(
    options: AuditExportOptions,
    poll: PollMetadata,
    totalVotes: number
  ): void {
    if (options.includeVoteLevelData) {
      throw new Error(
        'Cannot export vote-level records because choice, timestamp, and demographics can reveal ballot secrecy.'
      );
    }
    if (!options.anonymizeVoters) {
      throw new Error('Cannot export non-anonymized voter records.');
    }

    const configuredMinimum = Number.parseInt(process.env.MIN_K_ANONYMITY || '30', 10);
    const pollMinimum = Number(poll.min_k_anonymity) || 0;
    const privacyThreshold = Math.max(
      Number.isInteger(configuredMinimum) ? configuredMinimum : 30,
      pollMinimum
    );
    if (totalVotes < privacyThreshold) {
      throw new Error(
        `Cannot export results before the privacy threshold of ${privacyThreshold} votes is met.`
      );
    }
  }

  /**
   * Generate complete audit CSV export
   */
  async generateExport(options: AuditExportOptions): Promise<{
    csvContent: string;
    manifest: ExportManifest;
  }> {
    // Validate poll
    const poll = await this.validatePoll(options.pollId);

    // Get data
    const pollOptions = await this.getOptions(options.pollId);
    const aggregatedResults = await this.getAggregatedResults(options.pollId);
    const totalVotes = await this.getTotalVotes(options.pollId);
    const participantCount = await this.getParticipantCount(options.pollId);
    this.assertPrivacySafeExport(options, poll, totalVotes);

    // Fail closed: do not release an export if its audit write fails.
    await this.logExport(options, poll);

    // Build CSV content
    let csvContent = '';

    // Add BOM for Excel UTF-8 compatibility
    csvContent += '\uFEFF';

    // ===== SECTION 1: EXPORT METADATA =====
    csvContent += createCsvRow(['=== AUDIT EXPORT METADATA ===', '', '', '']);
    csvContent += createCsvRow(['Export ID', this.exportId, '', '']);
    csvContent += createCsvRow(['Generated At', formatTimestamp(new Date()), '', '']);
    csvContent += createCsvRow(['Generated By', options.adminEmail, '', '']);
    csvContent += createCsvRow(['', '', '', '']);

    // ===== SECTION 2: POLL INFORMATION =====
    csvContent += createCsvRow(['=== POLL INFORMATION ===', '', '', '']);
    csvContent += createCsvRow(['Poll ID', poll.id, '', '']);
    csvContent += createCsvRow(['Title', poll.title, '', '']);
    csvContent += createCsvRow(['Description', poll.description || 'N/A', '', '']);
    csvContent += createCsvRow(['Type', poll.type.toUpperCase(), '', '']);
    csvContent += createCsvRow(['Status', poll.status.toUpperCase(), '', '']);
    csvContent += createCsvRow(['Start Date', formatTimestamp(poll.start_at), '', '']);
    csvContent += createCsvRow(['End Date', formatTimestamp(poll.end_at), '', '']);
    csvContent += createCsvRow(['Published At', formatTimestamp(poll.published_at), '', '']);
    csvContent += createCsvRow(['Created At', formatTimestamp(poll.created_at), '', '']);
    
    // Add Questions (fallback to title if specific question is missing, matching mobile behavior)
    let referendumQuestion = (poll.audience_rules as any)?.referendum_question;
    let electionQuestion = (poll.audience_rules as any)?.election_question;

    if (poll.type === 'referendum' && !referendumQuestion) {
      referendumQuestion = poll.title;
    }
    if (poll.type === 'election' && !electionQuestion) {
      electionQuestion = poll.title;
    }
    
    if (referendumQuestion) {
      csvContent += createCsvRow(['Referendum Question', referendumQuestion, '', '']);
    }
    if (electionQuestion) {
      csvContent += createCsvRow(['Election Question', electionQuestion, '', '']);
    }

    csvContent += createCsvRow(['K-Anonymity Threshold', poll.min_k_anonymity.toString(), '', '']);
    csvContent += createCsvRow(['', '', '', '']);


    // ===== SECTION 3: AUDIENCE RULES =====
    csvContent += createCsvRow(['=== AUDIENCE ELIGIBILITY RULES ===', '', '', '']);
    const rules = poll.audience_rules || {};
    csvContent += createCsvRow(['Minimum Age', rules.min_age?.toString() || 'None', '', '']);
    csvContent += createCsvRow(['Maximum Age', rules.max_age?.toString() || 'None', '', '']);
    csvContent += createCsvRow(['Gender Restriction', rules.gender || 'All', '', '']);
    csvContent += createCsvRow(['Region Restriction', Array.isArray(rules.regions) ? rules.regions.join('; ') : 'All Regions', '', '']);
    csvContent += createCsvRow(['', '', '', '']);

    // ===== SECTION 4: POLL OPTIONS =====
    csvContent += createCsvRow(['=== POLL OPTIONS ===', '', '', '']);
    csvContent += createCsvRow(['Option ID', 'Option Text', 'Display Order', '']);
    for (const opt of pollOptions) {
      csvContent += createCsvRow([opt.id, opt.text, opt.display_order.toString(), '']);
    }
    csvContent += createCsvRow(['', '', '', '']);

    // ===== SECTION 5: AGGREGATED RESULTS =====
    csvContent += createCsvRow(['=== AGGREGATED RESULTS ===', '', '', '']);
    csvContent += createCsvRow(['Total Votes', totalVotes.toString(), '', '']);
    csvContent += createCsvRow(['Total Participants', participantCount.toString(), '', '']);
    csvContent += createCsvRow(['', '', '', '']);
    csvContent += createCsvRow(['Option ID', 'Option Text', 'Vote Count', 'Percentage']);

    for (const result of aggregatedResults) {
      const percentage = totalVotes > 0
        ? ((parseInt(result.vote_count, 10) / totalVotes) * 100).toFixed(2) + '%'
        : '0.00%';
      csvContent += createCsvRow([
        result.option_id,
        result.option_text,
        result.vote_count,
        percentage,
      ]);
    }
    csvContent += createCsvRow(['', '', '', '']);

    // ===== SECTION 7: INTEGRITY HASH =====
    // Calculate hash of all content above
    this.hashStream.update(csvContent);
    const integrityHash = this.hashStream.digest('hex').toUpperCase();

    csvContent += createCsvRow(['=== DATA INTEGRITY ===', '', '', '']);
    csvContent += createCsvRow(['Hash Algorithm', 'SHA-256', '', '']);
    csvContent += createCsvRow(['Dataset Hash', integrityHash, '', '']);
    csvContent += createCsvRow(['', '', '', '']);
    csvContent += createCsvRow(['*** END OF AUDIT EXPORT ***', '', '', '']);

    // Build manifest
    const manifest: ExportManifest = {
      exportId: this.exportId,
      generatedAt: new Date().toISOString(),
      generatedBy: {
        userId: options.adminUserId,
        email: options.adminEmail,
      },
      poll: {
        id: poll.id,
        title: poll.title,
        type: poll.type,
        status: poll.status,
        startAt: poll.start_at?.toISOString() || null,
        endAt: poll.end_at?.toISOString() || null,
      },
      dataScope: {
        includesVoteLevelData: options.includeVoteLevelData,
        votersAnonymized: options.anonymizeVoters,
        dateRangeStart: options.dateRangeStart?.toISOString() || null,
        dateRangeEnd: options.dateRangeEnd?.toISOString() || null,
      },
      statistics: {
        totalVotes,
        totalParticipants: participantCount,
        optionsCount: pollOptions.length,
      },
      integrityHash,
      hashAlgorithm: 'SHA-256',
    };

    return { csvContent, manifest };
  }

  /**
   * Create readable stream for large exports (memory efficient)
   */
  async createExportStream(options: AuditExportOptions): Promise<Readable> {
    const poll = await this.validatePoll(options.pollId);

    const self = this;
    const aggregatedResults = await this.getAggregatedResults(options.pollId);
    const totalVotes = await this.getTotalVotes(options.pollId);
    const participantCount = await this.getParticipantCount(options.pollId);
    this.assertPrivacySafeExport(options, poll, totalVotes);
    await this.logExport(options, poll);

    let headersSent = false;

    const readable = new Readable({
      async read() {
        try {
          if (!headersSent) {
            // Send all header sections at once
            let header = '\uFEFF'; // BOM

            // Metadata section
            header += createCsvRow(['=== AUDIT EXPORT METADATA ===', '', '', '']);
            header += createCsvRow(['Export ID', self.exportId, '', '']);
            header += createCsvRow(['Generated At', formatTimestamp(new Date()), '', '']);
            header += createCsvRow(['Generated By', options.adminEmail, '', '']);
            header += createCsvRow(['', '', '', '']);

            // Poll info section
            header += createCsvRow(['=== POLL INFORMATION ===', '', '', '']);
            header += createCsvRow(['Poll ID', poll.id, '', '']);
            header += createCsvRow(['Title', poll.title, '', '']);
            header += createCsvRow(['Type', poll.type.toUpperCase(), '', '']);
            header += createCsvRow(['Status', poll.status.toUpperCase(), '', '']);
            header += createCsvRow(['Start Date', formatTimestamp(poll.start_at), '', '']);
            header += createCsvRow(['End Date', formatTimestamp(poll.end_at), '', '']);
            
            // Add Questions for streaming (fallback to title)
            let refQ = (poll.audience_rules as any)?.referendum_question;
            let elecQ = (poll.audience_rules as any)?.election_question;

            if (poll.type === 'referendum' && !refQ) refQ = poll.title;
            if (poll.type === 'election' && !elecQ) elecQ = poll.title;

            if (refQ) header += createCsvRow(['Referendum Question', refQ, '', '']);
            if (elecQ) header += createCsvRow(['Election Question', elecQ, '', '']);

            header += createCsvRow(['K-Anonymity Threshold', poll.min_k_anonymity.toString(), '', '']);
            header += createCsvRow(['', '', '', '']);

            // Aggregated results
            header += createCsvRow(['=== AGGREGATED RESULTS ===', '', '', '']);
            header += createCsvRow(['Total Votes', totalVotes.toString(), '', '']);
            header += createCsvRow(['Total Participants', participantCount.toString(), '', '']);
            header += createCsvRow(['', '', '', '']);
            header += createCsvRow(['Option ID', 'Option Text', 'Vote Count', 'Percentage']);

            for (const result of aggregatedResults) {
              const percentage = totalVotes > 0
                ? ((parseInt(result.vote_count, 10) / totalVotes) * 100).toFixed(2) + '%'
                : '0.00%';
              header += createCsvRow([result.option_id, result.option_text, result.vote_count, percentage]);
            }
            header += createCsvRow(['', '', '', '']);

            this.push(header);
            headersSent = true;
            return;
          }
          this.push(null);
        } catch (error) {
          this.destroy(error as Error);
        }
      },
    });

    return readable;
  }
}

export default AuditExportService;
