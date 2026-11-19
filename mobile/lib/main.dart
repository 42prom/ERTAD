import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart' show kReleaseMode;
import 'package:flutter/services.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart'
    hide ChangeNotifierProvider, Consumer, Provider;
import 'package:logging/logging.dart';
import 'package:provider/provider.dart';
import 'package:flutter_localizations/flutter_localizations.dart';

import 'config/app_config.dart';
import 'core/feedback/ertad_feedback.dart';
import 'core/router/app_router.dart';
import 'core/state/shell_providers.dart';
import 'core/theme/ertad_theme.dart';
import 'services/storage_service.dart';
import 'services/notification_service.dart';
import 'services/localization_service.dart';
import 'services/service_locator.dart';
import 'services/api_request_exception.dart';
import 'screens/enrollment/intro_screen.dart';
import 'screens/dashboard/dashboard_screen.dart';

/// ERTAD Mobile App
///
/// Entry point for the Flutter application.
/// Initializes core services:
/// - Localization (i18n)
/// - Notifications (Firebase)
/// - Storage (Secure Storage)
/// - Enrollment checks
Future<void> main() async {
  if (kReleaseMode) {
    throw StateError(
      'ERTAD release is disabled until migration and provider verification are complete.',
    );
  }
  WidgetsFlutterBinding.ensureInitialized();
  ErrorWidget.builder = (FlutterErrorDetails details) =>
      ErtadCrashBoundaryCard(message: details.exceptionAsString());

  // Initialize localization service first so runApp renders immediately.
  final localizationService = LocalizationService();
  await localizationService.initialize();

  // Setup logging & non-blocking background startup tasks.
  Logger.root.level = Level.ALL;
  Logger.root.onRecord.listen((record) {
    debugPrint('${record.level.name}: ${record.time}: ${record.message}');
  });

  // Set preferred orientations & edge-to-edge immediately.
  await SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge);
  await SystemChrome.setPreferredOrientations([
    DeviceOrientation.portraitUp,
    DeviceOrientation.portraitDown,
  ]);

  runApp(
    ProviderScope(child: MyApp(localizationService: localizationService)),
  );

  // Run legacy secret purge and optional Firebase init without delaying first frame.
  Future<void>(() async {
    await StorageService().purgeLegacyVotingSecrets();
    try {
      await Firebase.initializeApp();
      await NotificationService().initialize();
    } catch (_) {
      // Optional in local/dev builds without Firebase config.
    }
  });
}

class MyApp extends ConsumerStatefulWidget {
  final LocalizationService localizationService;

  const MyApp({super.key, required this.localizationService});

  @override
  ConsumerState<MyApp> createState() => _MyAppState();
}

class _MyAppState extends ConsumerState<MyApp> {
  late final _devRouter = (!kReleaseMode && AppConfig.devWorkspace)
      ? createErtadRouter()
      : null;

  @override
  void dispose() {
    _devRouter?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final themeMode = ref.watch(themeModeProvider);

    return ChangeNotifierProvider<LocalizationService>.value(
      value: widget.localizationService,
      child: Consumer<LocalizationService>(
        builder: (context, locService, child) {
          final router = _devRouter;
          if (router != null) {
            return MaterialApp.router(
              title: 'ERTAD',
              theme: ErtadTheme.lightTheme,
              darkTheme: ErtadTheme.darkTheme,
              themeMode: themeMode,
              debugShowCheckedModeBanner: false,
              locale: locService.locale,
              supportedLocales: const [Locale('en'), Locale('ka')],
              localizationsDelegates: const [
                GlobalMaterialLocalizations.delegate,
                GlobalWidgetsLocalizations.delegate,
                GlobalCupertinoLocalizations.delegate,
              ],
              builder: (context, child) =>
                  _ErtadLaunchSplash(child: child ?? const SizedBox.shrink()),
              routerConfig: router,
            );
          }

          return MaterialApp(
            title: 'ERTAD',
            theme: ErtadTheme.lightTheme,
            darkTheme: ErtadTheme.darkTheme,
            themeMode: themeMode,
            debugShowCheckedModeBanner: false,
            locale: locService.locale,
            supportedLocales: const [
              Locale('en'), // English
              Locale('ka'), // Georgian
            ],
            localizationsDelegates: const [
              GlobalMaterialLocalizations.delegate,
              GlobalWidgetsLocalizations.delegate,
              GlobalCupertinoLocalizations.delegate,
            ],
            home: const SplashScreen(),
          );
        },
      ),
    );
  }
}

class SplashScreen extends StatefulWidget {
  const SplashScreen({super.key});

  @override
  State<SplashScreen> createState() => _SplashScreenState();
}

class _SplashScreenState extends State<SplashScreen> {
  final StorageService _storageService = StorageService();
  bool _checking = false;
  bool _unavailable = false;

  @override
  void initState() {
    super.initState();
    _checkEnrollment();
  }

  Future<void> _checkEnrollment() async {
    if (_checking || !mounted) return;
    setState(() {
      _checking = true;
      _unavailable = false;
    });
    try {
      final isEnrolled = await _storageService.isEnrolled();
      final credential = await _storageService.getCredential();
      if (!mounted) return;
      if (isEnrolled && credential != null) {
        final api = ServiceLocator.apiService;
        api.setCredential(credential);
        try {
          // Retained authenticated read probe, not a revocation or membership check.
          await api.getPolls();
        } on ApiRequestException catch (error) {
          if (error.statusCode != 401) rethrow;
          if (!mounted) return;
          await _storageService.clearAll();
          if (!mounted) return;
          Navigator.of(context).pushReplacement(
            MaterialPageRoute(builder: (context) => const IntroScreen()),
          );
          return;
        }
        if (!mounted) return;
        Navigator.of(context).pushReplacement(
          MaterialPageRoute(builder: (context) => const DashboardScreen()),
        );
      } else {
        if (isEnrolled) await _storageService.setEnrolled(false);
        if (!mounted) return;
        Navigator.of(context).pushReplacement(
          MaterialPageRoute(builder: (context) => const IntroScreen()),
        );
      }
    } catch (_) {
      // Offline, forbidden, server and local storage failures never open a session.
      // Preserve credentials on uncertain outcomes; do not log response bodies.
      if (mounted) setState(() => _unavailable = true);
    } finally {
      if (mounted) {
        setState(() => _checking = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final locService = Provider.of<LocalizationService>(context);

    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Image.asset(
                    'assets/images/ertad-mark.png',
                    width: 150,
                    height: 150,
                  ),
                  const SizedBox(height: 24),
                  Text(
                    locService.translate('app_name'),
                    textAlign: TextAlign.center,
                    style: Theme.of(context).textTheme.headlineLarge?.copyWith(
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                  const SizedBox(height: 8),
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 32.0),
                    child: Text(
                      locService.translate('app_subtitle'),
                      textAlign: TextAlign.center,
                      style: Theme.of(
                        context,
                      ).textTheme.bodyLarge?.copyWith(color: Colors.grey),
                    ),
                  ),
                  const SizedBox(height: 40),
                  if (_unavailable) ...[
                    Semantics(
                      liveRegion: true,
                      child: Text(
                        locService.translate('session_check_unavailable'),
                        textAlign: TextAlign.center,
                      ),
                    ),
                    const SizedBox(height: 16),
                    FilledButton(
                      style: FilledButton.styleFrom(
                        minimumSize: const Size(0, 48),
                      ),
                      onPressed: _checking ? null : _checkEnrollment,
                      child: Text(locService.translate('retry')),
                    ),
                  ] else
                    const CircularProgressIndicator(),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _ErtadLaunchSplash extends StatefulWidget {
  final Widget child;

  const _ErtadLaunchSplash({required this.child});

  @override
  State<_ErtadLaunchSplash> createState() => _ErtadLaunchSplashState();
}

class _ErtadLaunchSplashState extends State<_ErtadLaunchSplash>
    with SingleTickerProviderStateMixin {
  static const String _kaPhrase = 'ერთად ყველაფერი გამოგვივა';
  static const String _enPhrase = 'Together, we can do anything';

  late final AnimationController _controller;
  bool _visible = true;
  bool _done = false;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1350),
    )..forward();

    Future<void>.delayed(const Duration(milliseconds: 2100), () {
      if (!mounted) return;
      setState(() => _visible = false);
      Future<void>.delayed(const Duration(milliseconds: 360), () {
        if (!mounted) return;
        setState(() => _done = true);
      });
    });
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (_done) return widget.child;
    final isKa = Localizations.localeOf(context).languageCode == 'ka';
    final phrase = isKa ? _kaPhrase : _enPhrase;

    return Stack(
      children: [
        widget.child,
        Positioned.fill(
          child: IgnorePointer(
            ignoring: !_visible,
            child: AnimatedOpacity(
              opacity: _visible ? 1.0 : 0.0,
              duration: const Duration(milliseconds: 340),
              curve: Curves.easeOut,
              child: DecoratedBox(
                decoration: const BoxDecoration(
                  gradient: LinearGradient(
                    begin: Alignment.topCenter,
                    end: Alignment.bottomCenter,
                    colors: [Color(0xFFFFFFFF), Color(0xFFF1F5FF)],
                  ),
                ),
                child: SafeArea(
                  child: Center(
                    child: Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 28),
                      child: AnimatedBuilder(
                        animation: _controller,
                        builder: (context, _) {
                          final t = Curves.easeOutCubic.transform(
                            _controller.value,
                          );
                          final count = (phrase.length * t).ceil().clamp(
                            0,
                            phrase.length,
                          );
                          final visibleText = phrase.substring(0, count);
                          final logoWidth =
                              (MediaQuery.sizeOf(context).width * 0.88).clamp(
                                240.0,
                                420.0,
                              );
                          return Column(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Opacity(
                                opacity: (t * 2.5).clamp(0.0, 1.0),
                                child: Image.asset(
                                  'assets/images/splash_logo.png',
                                  width: logoWidth,
                                  fit: BoxFit.contain,
                                ),
                              ),
                              const SizedBox(height: 24),
                              Opacity(
                                opacity: (t * 2).clamp(0.0, 1.0),
                                child: Container(
                                  padding: const EdgeInsets.symmetric(
                                    horizontal: 18,
                                    vertical: 8,
                                  ),
                                  decoration: BoxDecoration(
                                    color: const Color(0xFF1D4ED8),
                                    borderRadius: BorderRadius.circular(999),
                                    boxShadow: [
                                      BoxShadow(
                                        color: const Color(
                                          0xFF1D4ED8,
                                        ).withValues(alpha: 0.22),
                                        blurRadius: 18,
                                        offset: const Offset(0, 6),
                                      ),
                                    ],
                                  ),
                                  child: const Text(
                                    'ERTAD',
                                    style: TextStyle(
                                      color: Colors.white,
                                      fontSize: 15,
                                      fontWeight: FontWeight.w800,
                                      letterSpacing: 3.0,
                                      decoration: TextDecoration.none,
                                    ),
                                  ),
                                ),
                              ),
                              const SizedBox(height: 22),
                              Text(
                                visibleText,
                                textAlign: TextAlign.center,
                                style: const TextStyle(
                                  color: Color(0xFF0F172A),
                                  fontSize: 22,
                                  fontWeight: FontWeight.w700,
                                  height: 1.35,
                                  letterSpacing: -0.2,
                                  decoration: TextDecoration.none,
                                ),
                              ),
                            ],
                          );
                        },
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }
}
