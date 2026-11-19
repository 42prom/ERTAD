import { IFaceMatchProvider, ILivenessProvider, VerificationResult } from './types';
import { HttpClientFactory } from '../../utils/httpClient';
import { SettingsService } from '../settingsService';

/** Face presence and client-side blink flags do not establish server-verified PAD. */
export class InHouseLivenessProvider implements ILivenessProvider {
  async verify(_selfie: Buffer, _apiKey?: string): Promise<VerificationResult> {
    return { success: false, error: 'LIVENESS_ASSURANCE_NOT_IMPLEMENTED', isRetryable: false };
  }
}

/**
 * In-House Face Match Provider
 * Uses local biometric service (InsightFace) for face matching
 * with automatic image normalization for consistent results across devices
 */
export class InHouseFaceMatchProvider implements IFaceMatchProvider {
  async match(selfie: Buffer, docPortrait: Buffer, _apiKey?: string): Promise<VerificationResult> {
    try {
      const client = HttpClientFactory.getBiometricClient();

      // Convert to base64
      const selfieBase64 = selfie.toString('base64');
      const docBase64 = docPortrait.toString('base64');

      console.log('[InHouseFaceMatch] Calling biometric service with normalization...');
      const selfieMb = selfie.length / (1024 * 1024);
      const docMb = docPortrait.length / (1024 * 1024);
      console.log(`  Selfie size: ${selfie.length} bytes (${selfieMb.toFixed(2)} MB)`);
      console.log(`  Document size: ${docPortrait.length} bytes (${docMb.toFixed(2)} MB)`);

      if (selfieMb > 3 || docMb > 3) {
        console.warn('[InHouseFaceMatch] WARNING: Large image size detected. Consider client-side compression.');
      }


      // Call biometric service with normalization enabled
      // This handles zoom/crop/quality differences across devices
      const response = await client.post<{
        match: boolean;
        score: number;
        threshold: number;
        error?: string;
        faces_detected?: number[];
        latency_ms?: number;
        normalization?: {
          image1_quality: number;
          image2_quality: number;
          normalized: boolean;
        };
      }>('/verify-normalized', {
        image1_base64: selfieBase64,
        image2_base64: docBase64,
        normalize: true
      });

      console.log('[InHouseFaceMatch] Service response:', {
        match: response.data.match,
        score: response.data.score?.toFixed(3),
        threshold: response.data.threshold,
        faces: response.data.faces_detected,
        latency: response.data.latency_ms,
        normalization: response.data.normalization
      });

      const { score, error, faces_detected } = response.data;

      if (error) {
        return {
          success: false,
          score: 0,
          error,
          isRetryable: true
        };
      }

      // Check if faces were detected in both images
      if (faces_detected) {
        if (faces_detected[0] === 0) {
          return {
            success: false,
            score: 0,
            error: 'No face detected in selfie',
            isRetryable: true
          };
        }
        if (faces_detected[1] === 0) {
          return {
            success: false,
            score: 0,
            error: 'No face detected in document photo',
            isRetryable: false
          };
        }
      }

      
      // Get dynamic threshold from settings service
      const threshold = await SettingsService.getBiometricThreshold();
      const isMatch = score >= threshold;

      return {
        success: isMatch,
        score: score || 0,
        message: isMatch
          ? `Face match successful (${(score * 100).toFixed(1)}% similarity)`
          : `Face match failed (${(score * 100).toFixed(1)}% similarity - threshold: ${threshold})`,
        isRetryable: !isMatch && score > (threshold - 0.1)  // Allow retry if close
      };
    } catch (error: any) {
      console.error('[InHouseFaceMatch] Error calling biometric service:', error.message);

      // Check if it's a connection error
      if (error.code === 'ECONNREFUSED' || error.message?.includes('ECONNREFUSED')) {
        return {
          success: false,
          score: 0,
          error: 'Biometric service is not running. Please start it with: cd biometric-service && python main.py',
          isRetryable: false
        };
      }

      return {
        success: false,
        score: 0,
        error: error.message || 'Biometric service error',
        isRetryable: true
      };
    }
  }
}
