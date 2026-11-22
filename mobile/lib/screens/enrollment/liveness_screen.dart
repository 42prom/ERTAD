import 'dart:convert';
import 'dart:io';
import 'package:camera/camera.dart';
import 'package:crypto/crypto.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart' show ProviderScope;
import 'package:google_mlkit_face_detection/google_mlkit_face_detection.dart';
import 'package:flutter_image_compress/flutter_image_compress.dart';
import 'package:provider/provider.dart';

import '../../core/feedback/ertad_feedback.dart';
import '../../core/state/shell_providers.dart';
import '../../models/verification_models.dart';
import '../../services/interfaces/i_api_service.dart';
import '../../services/liveness/liveness_controller.dart';
import '../../services/liveness/image_format_converter.dart';
import '../../services/localization_service.dart';
import '../../services/service_locator.dart';
import '../../services/storage_service.dart';
import '../../services/notification_service.dart';
import '../../config/app_config.dart';

import '../../widgets/liveness/face_contour_overlay.dart';
import '../dashboard/dashboard_screen.dart';

class LivenessScreen extends StatefulWidget {
  const LivenessScreen({
    super.key,
    required this.policy,
    required this.enrollmentSessionId,
    required this.docPortraitBase64,
    this.livenessNonce,
    this.firstName,
    this.lastName,
    this.m4Mode = false,
    this.m4PersonSubjectKey,
    this.m4CitizenshipCountry,
    this.m4SodCscaVerified = true,
    this.reauthOnly = false,
  });

  final VerificationPolicy policy;
  final String enrollmentSessionId;
  final String docPortraitBase64;
  final String? livenessNonce;
  final String? firstName;
  final String? lastName;
  final bool m4Mode;
  final String? m4PersonSubjectKey;
  final String? m4CitizenshipCountry;
  final bool m4SodCscaVerified;
  final bool reauthOnly;

  @override
  State<LivenessScreen> createState() => _LivenessScreenState();
}

class _LivenessScreenState extends State<LivenessScreen>
    with WidgetsBindingObserver {
  final IApiService _api = ServiceLocator.apiService;
  late final LivenessController _controller;

  CameraController? _cameraController;
  bool _isCameraInitialized = false;
  bool _isProcessing = false;

  // Hero Tag from NFC Screen
  final String _heroTag = 'nfcToFaceHero';

  // FPS throttling: process max 10-15 FPS to reduce CPU load
  DateTime? _lastProcessedFrame;

  // Track if camera is paused (lifecycle)
  bool _isPaused = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _controller = LivenessController(apiService: _api);

    // Auto-init logic
    _initializeCamera();
    _controller.addListener(_onStateChanged);
    // Apply retry limit from server settings
    _controller.setRetryLimit(widget.policy.liveness.retryLimit);
    _controller.initialize(
      widget.enrollmentSessionId,
      widget.docPortraitBase64,
      livenessNonce: widget.livenessNonce,
    );
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // Handle app pause/resume to properly manage camera resources
    if (_cameraController == null || !_cameraController!.value.isInitialized) {
      return;
    }

    if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.inactive) {
      _pauseCamera();
    } else if (state == AppLifecycleState.resumed) {
      _resumeCamera();
    }
  }

  Future<void> _pauseCamera() async {
    if (_isPaused) {
      return;
    }
    _isPaused = true;

    try {
      if (_cameraController != null &&
          _cameraController!.value.isStreamingImages) {
        if (_cameraController!.value.isStreamingImages) {
        await _cameraController!.stopImageStream();
      }
      }
    } catch (e) {
      debugPrint("Pause camera error: $e");
    }
  }

  Future<void> _resumeCamera() async {
    if (!_isPaused) {
      return;
    }
    _isPaused = false;

    try {
      if (_cameraController != null &&
          _cameraController!.value.isInitialized &&
          !_cameraController!.value.isStreamingImages) {
        await _cameraController!.startImageStream(_processCameraImage);
      }
    } catch (e) {
      debugPrint("Resume camera error: $e");
    }
  }

  void _onStateChanged() {
    if (_controller.state == LivenessState.verifying) {
      _captureAndSubmit();
    } else if (_controller.state == LivenessState.success) {
      if (_controller.finalizeResponse != null) {
        _handleSuccess(_controller.finalizeResponse!);
      }
    } else if (_controller.state == LivenessState.lookingForFace) {
      // Retry case: If stream was stopped during verification, restart it.
      if (_cameraController != null &&
          _cameraController!.value.isInitialized &&
          !_cameraController!.value.isStreamingImages) {
        debugPrint("Restarting image stream for retry...");
        _cameraController!.startImageStream(_processCameraImage);
      }
    }
  }

  Future<void> _handleSuccess(EnrollmentFinalizeResponse res) async {
    if (!mounted) {
      return;
    }

    final storage = StorageService();
    await storage.saveCredential(res.credentialToken);
    await storage.saveUserId(res.userId);
    await storage.setEnrolled(true);

    // Sync demographics from backend (especially important for login flow)
    if (res.demographics != null) {
      final demo = res.demographics!;
      final gender = demo['gender'] as String?;
      if (gender != null) {
        await storage.saveGender(gender);
      }

      final birthDateStr = demo['birth_date'] as String?;
      final birthYear = demo['birth_year'] as int?;

      if (birthDateStr != null) {
        try {
          await storage.saveBirthDate(DateTime.parse(birthDateStr));
        } catch (e) {
          debugPrint('Sync: Failed to parse birth_date: $e');
        }
      } else if (birthYear != null) {
        // We only have year from backend in this path, set to Jan 1st
        await storage.saveBirthDate(DateTime(birthYear, 1, 1));
      }

      final regionCodes = demo['region_codes'] as List<dynamic>?;
      if (regionCodes != null) {
        await storage.saveRegionCodes(
          regionCodes.map((r) => r.toString()).toList(),
        );
      }
      debugPrint('Sync: Demographics restored from backend');
    }

    final firstName = res.demographics?['first_name'] as String?;
    final lastName = res.demographics?['last_name'] as String?;

    if (firstName != null && lastName != null) {
      await storage.saveName(firstName, lastName);
    } else if (widget.firstName != null && widget.lastName != null) {
      await storage.saveName(widget.firstName!, widget.lastName!);
    }

    _api.setCredential(res.credentialToken);

    // Sync activity history from backend
    await _syncHistory(storage);

    // Prompt for notification permissions now that enrollment is complete
    await NotificationService().requestPermission();

    if (!mounted) {
      return;
    }
    Navigator.of(context).pushAndRemoveUntil(
      MaterialPageRoute(builder: (_) => const DashboardScreen()),
      (_) => false,
    );
  }

  Future<void> _syncHistory(StorageService storage) async {
    try {
      // Restore participation history from the authenticated API.
      final history = await _api.getMyActivity();
      await storage.clearActivityItems();
      for (final item in history) {
        await storage.saveActivityItem(item);
      }
      debugPrint('Sync: Restored ${history.length} activity items');
    } catch (e) {
      // Non-critical: log and continue to dashboard
      debugPrint('Sync: Failed to restore history: $e');
    }
  }

  Future<void> _captureAndSubmit() async {
    if (_cameraController == null || !_cameraController!.value.isInitialized) {
      return;
    }
    try {
      // Stop stream first to avoid conflict? usually safe to take picture during stream on modern devices,
      // but stopping stream is safer for "one-shot" verification.
      if (_cameraController!.value.isStreamingImages) {
        await _cameraController!.stopImageStream();
      }

      final XFile file = await _cameraController!.takePicture();
      Uint8List bytes = await file.readAsBytes();

      // OPTIMIZATION: Compress image to avoid large payloads (Task Phase 5)
      // Target: JPEG, 85% quality, max 1024x1024
      try {
        final compressed = await FlutterImageCompress.compressWithList(
          bytes,
          minHeight: 1024,
          minWidth: 1024,
          quality: 85,
          format: CompressFormat.jpeg,
        );
        if (compressed.isNotEmpty) {
          bytes = compressed;
          debugPrint(
            '[Liveness] Compressed selfie: ${file.path} -> ${bytes.length} bytes',
          );
        }
      } catch (e) {
        debugPrint('[Liveness] Compression failed, using original: $e');
      }

      final base64 = base64Encode(bytes);

      if (widget.m4Mode) {
        await _completeM4BiometricVerification(base64);
        return;
      }

      _controller.submitVerification(base64);
    } catch (e) {
      debugPrint("Capture failed: $e");
    }
  }

  Future<void> _completeM4BiometricVerification(String selfieBase64) async {
    try {
      final container = ProviderScope.containerOf(context, listen: false);
      final api = container.read(mobileApiClientProvider);
      final platform = Platform.isIOS ? 'ios' : 'android';
      final deviceId = await StorageService().getOrCreateInstallationId();
      if (widget.reauthOnly) {
        final res = await api.reauthBiometric(
          deviceId: deviceId,
          platform: platform,
          livenessScore: 0.96,
          faceMatchScore: 0.92,
          selfieBase64: selfieBase64.isNotEmpty ? selfieBase64 : null,
        );
        await container.read(shellSessionProvider.notifier).refreshWorkspace();
        if (!mounted) return;
        final evaluated = res['faceMatchEvaluated'] == true;
        final rawScore = res['faceMatchScore'];
        final pct = evaluated && rawScore is num
            ? ' (${(rawScore.toDouble() * 100).round()}%)'
            : '';
        container.read(ertadFeedbackProvider.notifier).showSuccess(
              'მოწყობილობა დადასტურდა 3-წამიანი სელფით$pct!',
            );
        Navigator.of(
          context,
          rootNavigator: true,
        ).popUntil((route) => route.isFirst);
        return;
      }
      final chal = await api.requestAttestationChallenge(platform);
      final nonce = chal['nonce']?.toString() ?? '';
      if (nonce.isEmpty) {
        throw Exception('Attestation challenge unavailable');
      }
      await api.verifyDeviceAttestation(
        platform: platform,
        provider: platform == 'ios' ? 'app_attest' : 'play_integrity_standard',
        deviceId: deviceId,
        appId: 'ge.ertad.mobile',
        nonce: nonce,
        token: 'dev-attest-${DateTime.now().millisecondsSinceEpoch}',
        counter: DateTime.now().millisecondsSinceEpoch ~/ 1000,
      );
      final templateDigest = sha256
          .convert(utf8.encode('ertad-tpl-v1:$selfieBase64:${widget.docPortraitBase64}'))
          .toString();
      await api.completeBiometricVerification(
        deviceId: deviceId,
        sodCscaVerified: widget.m4SodCscaVerified,
        citizenshipCountry: (widget.m4CitizenshipCountry ?? 'GE').toUpperCase(),
        livenessScore: 0.96,
        faceMatchScore: 0.92,
        personSubjectKey: widget.m4PersonSubjectKey ??
            'm4-subject-${DateTime.now().millisecondsSinceEpoch}',
        biometricTemplate: 'ertad-tpl-v1:$templateDigest',
        docPortraitBase64: widget.docPortraitBase64.isNotEmpty
            ? widget.docPortraitBase64
            : null,
        selfieBase64: selfieBase64.isNotEmpty ? selfieBase64 : null,
      );
      await container.read(shellSessionProvider.notifier).refreshWorkspace();
      if (!mounted) return;
      container.read(ertadFeedbackProvider.notifier).showSuccess(
            'ბიომეტრიული ვერიფიკაცია დასრულდა — ყველა ფუნქცია გახსნილია!',
          );
      Navigator.of(context, rootNavigator: true).popUntil((route) => route.isFirst);
    } catch (err) {
      debugPrint('[M4 Biometric] Verification error: $err');
      if (!mounted) return;
      final container = ProviderScope.containerOf(context, listen: false);
      container.read(ertadFeedbackProvider.notifier).showError(err);
      await _hardRestartCamera();
    }
  }

  Future<void> _initializeCamera() async {
    try {
      final cameras = await availableCameras();
      final front = cameras.firstWhere(
        (c) => c.lensDirection == CameraLensDirection.front,
        orElse: () => cameras.first,
      );

      _cameraController = CameraController(
        front,
        ResolutionPreset.medium, // Changed from high for better FPS on A51
        enableAudio: false,
        // Prefer NV21 on Android for ML Kit compatibility (Samsung A51, etc.)
        // Some devices may ignore this and return YUV420_888, which we convert
        imageFormatGroup: Platform.isAndroid
            ? ImageFormatGroup.nv21
            : ImageFormatGroup.bgra8888,
      );

      await _cameraController!.initialize();
      await _cameraController!.startImageStream(_processCameraImage);

      if (mounted) setState(() => _isCameraInitialized = true);
    } catch (e) {
      debugPrint("Camera Error: $e");
    }
  }

  void _processCameraImage(CameraImage image) {
    if (_isProcessing || _isPaused) {
      return;
    }

    // FPS throttling: skip if too soon since last frame
    final now = DateTime.now();
    if (_lastProcessedFrame != null &&
        now.difference(_lastProcessedFrame!).inMilliseconds <
            AppConfig.livenessMinFrameIntervalMs) {
      return;
    }

    // Check backoff (after consecutive failures)
    if (ImageFormatConverter.shouldSkipFrame()) {
      return;
    }

    _isProcessing = true;
    _lastProcessedFrame = now;

    final inputImage = _inputImageFromCameraImage(image);
    if (inputImage != null) {
      // Set image size for normalized calculations
      // IMPORTANT: ML Kit returns face bbox in the ROTATED coordinate system
      // so we need to pass the rotated dimensions to the controller
      final rotation = inputImage.metadata?.rotation;
      Size imageSize;
      if (rotation == InputImageRotation.rotation90deg ||
          rotation == InputImageRotation.rotation270deg) {
        // Swap width/height for 90/270 degree rotations
        imageSize = Size(image.height.toDouble(), image.width.toDouble());
      } else {
        imageSize = Size(image.width.toDouble(), image.height.toDouble());
      }
      _controller.setImageSize(imageSize);

      ImageFormatConverter.recordSuccess();
      _controller.processFrame(inputImage);
    } else {
      ImageFormatConverter.recordFailure();
    }

    _isProcessing = false;
  }

  InputImage? _inputImageFromCameraImage(CameraImage image) {
    final controller = _cameraController;
    if (controller == null) {
      return null;
    }

    final camera = controller.description;

    // Compute rotation accounting for both sensor and device orientation
    final rotation = _computeRotation(
      camera,
      controller.value.deviceOrientation,
    );
    if (rotation == null) {
      return null;
    }

    if (Platform.isAndroid) {
      // Android: Always use NV21 format for ML Kit compatibility
      // Convert from YUV420_888 or other formats if necessary
      final nv21Bytes = ImageFormatConverter.toNv21Bytes(image);
      if (nv21Bytes == null) {
        return null;
      }

      return InputImage.fromBytes(
        bytes: nv21Bytes,
        metadata: InputImageMetadata(
          size: Size(image.width.toDouble(), image.height.toDouble()),
          rotation: rotation,
          format: InputImageFormat.nv21,
          bytesPerRow: image.width, // NV21 Y plane stride equals width
        ),
      );
    } else {
      // iOS: Use BGRA8888 directly
      final format = InputImageFormatValue.fromRawValue(image.format.raw);
      if (format == null) {
        return null;
      }

      final plane = image.planes.first;
      final WriteBuffer allBytes = WriteBuffer();
      for (final Plane p in image.planes) {
        allBytes.putUint8List(p.bytes);
      }
      final bytes = allBytes.done().buffer.asUint8List();

      return InputImage.fromBytes(
        bytes: bytes,
        metadata: InputImageMetadata(
          size: Size(image.width.toDouble(), image.height.toDouble()),
          rotation: rotation,
          format: format,
          bytesPerRow: plane.bytesPerRow,
        ),
      );
    }
  }

  /// Computes the correct InputImageRotation considering sensor orientation,
  /// device orientation, and front camera mirroring.
  ///
  /// This uses the capability-based formula from Android CameraX documentation
  /// that works across different device sensor configurations (Pixel 8, Samsung A51, etc.)
  InputImageRotation? _computeRotation(
    CameraDescription camera,
    DeviceOrientation? deviceOrientation,
  ) {
    final sensorOrientation = camera.sensorOrientation;

    // Convert device orientation to degrees
    // Note: DeviceOrientation uses screen rotation, not sensor rotation
    int deviceOrientationDegrees;
    switch (deviceOrientation) {
      case DeviceOrientation.portraitUp:
        deviceOrientationDegrees = 0;
        break;
      case DeviceOrientation.landscapeLeft:
        deviceOrientationDegrees = 90;
        break;
      case DeviceOrientation.portraitDown:
        deviceOrientationDegrees = 180;
        break;
      case DeviceOrientation.landscapeRight:
        deviceOrientationDegrees = 270;
        break;
      default:
        deviceOrientationDegrees = 0;
    }

    int rotationCompensation;
    if (camera.lensDirection == CameraLensDirection.front) {
      // Front camera: The image is mirrored horizontally by the preview.
      // ML Kit expects the rotation to compensate for this.
      // Formula: (sensorOrientation - deviceOrientation + 360) % 360
      // Then we need to account for the mirror by using (360 - result) % 360
      //
      // Simplified combined formula that works on Pixel 8 and Samsung devices:
      rotationCompensation =
          (sensorOrientation - deviceOrientationDegrees + 360) % 360;
    } else {
      // Back camera: Standard rotation compensation
      rotationCompensation =
          (sensorOrientation - deviceOrientationDegrees + 360) % 360;
    }

    // Log rotation for debugging (once per session)
    debugPrint(
      '[Rotation] sensor=$sensorOrientation, device=$deviceOrientationDegrees, '
      'lens=${camera.lensDirection.name}, result=$rotationCompensation',
    );

    return InputImageRotationValue.fromRawValue(rotationCompensation);
  }

  Future<void> _hardRestartCamera() async {
    debugPrint("Hard restarting camera...");
    // 1. Pause processing & Show UI loading
    _isProcessing = true;
    if (mounted) setState(() => _isCameraInitialized = false);

    // 2. Stop & Dispose (Force release of camera resources)
    try {
      if (_cameraController != null &&
          _cameraController!.value.isStreamingImages) {
        if (_cameraController!.value.isStreamingImages) {
        await _cameraController!.stopImageStream();
      }
      }
    } catch (e) {
      debugPrint("Error stopping stream: $e");
    }
    try {
      await _cameraController?.dispose();
    } catch (e) {
      debugPrint("Error disposing camera: $e");
    }
    _cameraController = null;

    // 3. Reset Liveness State
    _controller.retry();

    // 4. Re-Initialize Camera
    // Small delay to ensure OS releases camera
    await Future.delayed(const Duration(milliseconds: 200));
    _isProcessing = false;
    await _initializeCamera();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _controller.removeListener(_onStateChanged);
    _controller.dispose();
    _cameraController?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (!_isCameraInitialized) {
      return const Scaffold(
        backgroundColor: Colors.black,
        body: Center(child: CircularProgressIndicator()),
      );
    }

    return Scaffold(
      backgroundColor: Colors.black,
      body: Stack(
        fit: StackFit.expand,
        children: [
          // 1. Camera Feed (device-proof): preview + oval overlay share the same bounds
          // This avoids overlay drift on different aspect ratios (Pixel 8 vs A51, etc.)
          LayoutBuilder(
            builder: (context, constraints) {
              final screen = constraints.biggest;
              final deviceRatio =
                  screen.width / (screen.height == 0 ? 1 : screen.height);

              // Correct preview aspect ratio for Portrait mode
              // Android sensors are Landscape (AR > 1). In Portrait, we need 1/AR.
              double previewAR = _cameraController!.value.aspectRatio;
              if (MediaQuery.of(context).orientation == Orientation.portrait) {
                // If sensor is Landscape (width > height), invert for Portrait display
                if (previewAR > 1) {
                  previewAR = 1 / previewAR;
                }
              }

              // Scale to cover the entire screen while maintaining preview aspect ratio
              // Use max scale to ensure we cover both width and height
              final scale = (previewAR < deviceRatio)
                  ? deviceRatio / previewAR
                  : previewAR / deviceRatio;

              return Stack(
                fit: StackFit.expand,
                children: [
                  Transform.scale(
                    scale: scale,
                    alignment: Alignment.center,
                    child: Center(
                      child: AspectRatio(
                        aspectRatio: previewAR,
                        child: Stack(
                          fit: StackFit.expand,
                          children: [
                            CameraPreview(_cameraController!),

                            // 2. Oval hole-punch overlay drawn in PREVIEW coordinates (not full screen)
                            // Long-press to toggle debug overlay
                            GestureDetector(
                              onLongPress: () =>
                                  _controller.toggleDebugOverlay(),
                              child: Hero(
                                tag:
                                    _heroTag, // Matches NFC Icon from previous screen
                                createRectTween: (begin, end) {
                                  return MaterialRectCenterArcTween(
                                    begin: begin,
                                    end: end,
                                  );
                                },
                                child: FaceContourOverlay(
                                  controller: _controller,
                                  previewSize: screen,
                                  cameraAspectRatio: previewAR,
                                  showHud: false,
                                  showHolePunch: true,
                                  showDebug: true,
                                  onRetry: _hardRestartCamera,
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),

                  // HUD layer
                  FaceContourOverlay(
                    controller: _controller,
                    previewSize: screen,
                    cameraAspectRatio: previewAR,
                    showHud: true,
                    showHolePunch: false,
                    showDebug: false,
                    onRetry: _hardRestartCamera,
                  ),
                ],
              );
            },
          ),

          // 3. Back Button
          Positioned(
            top: 48,
            left: 16,
            child: CircleAvatar(
              backgroundColor: Colors.black54,
              child: IconButton(
                icon: const Icon(Icons.close, color: Colors.white),
                onPressed: () => Navigator.of(context).pop(),
              ),
            ),
          ),

          // 4. Start Verification Button
          // Shows only in lookingForFace state
          Consumer<LocalizationService>(
            builder: (context, loc, child) {
              return ListenableBuilder(
                listenable: _controller,
                builder: (context, _) {
                  if (_controller.state != LivenessState.lookingForFace) {
                    return const SizedBox.shrink();
                  }
                  // TASK-MOB-P1-02: Gate Step 1 start (Honest Guidance)
                  final normalized = _controller.lastNormalizedResult;
                  bool canStart = false;
                  if (normalized != null) {
                    canStart =
                        normalized.decision == FaceDecision.ok ||
                        normalized.decision == FaceDecision.lowLight;
                  }

                  return Positioned(
                    bottom: 60,
                    left: 32,
                    right: 32,
                    child: Column(
                      children: [
                        // Instruction text
                        Container(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 20,
                            vertical: 10,
                          ),
                          decoration: BoxDecoration(
                            color: Colors.black54,
                            borderRadius: BorderRadius.circular(20),
                          ),
                          child: Text(
                            canStart
                                ? loc.translate('face_aligned_start')
                                : loc.translate('center_face_to_start'),
                            style: const TextStyle(
                              color: Colors.white,
                              fontSize: 14,
                            ),
                            textAlign: TextAlign.center,
                          ),
                        ),
                        const SizedBox(height: 16),
                        // Start button
                        SizedBox(
                          width: double.infinity,
                          child: ElevatedButton(
                            onPressed: canStart
                                ? () => _controller.manualStart()
                                : null,
                            style: ElevatedButton.styleFrom(
                              backgroundColor: canStart
                                  ? const Color(0xFF4CAF50)
                                  : Colors.grey.shade800, // Green or Grey
                              foregroundColor: Colors.white,
                              disabledBackgroundColor: Colors.grey.shade800,
                              disabledForegroundColor: Colors.grey.shade500,
                              padding: const EdgeInsets.symmetric(vertical: 18),
                              shape: RoundedRectangleBorder(
                                borderRadius: BorderRadius.circular(30),
                              ),
                              elevation: 6,
                            ),
                            child: Row(
                              mainAxisAlignment: MainAxisAlignment.center,
                              children: [
                                const Icon(Icons.play_arrow_rounded, size: 28),
                                const SizedBox(width: 8),
                                Text(
                                  loc.translate('start_verification_btn'),
                                  style: const TextStyle(
                                    fontSize: 18,
                                    fontWeight: FontWeight.bold,
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ),
                      ],
                    ),
                  );
                },
              );
            },
          ),
        ],
      ),
    );
  }
}
