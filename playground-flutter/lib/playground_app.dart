import 'package:appduct/appduct.dart';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import 'playground_tools.dart';

export 'playground_tools.dart';

/// The playground: a Tools tab and a Status tab behind go_router, so an Appduct link reaching the
/// app is exercised against a real router (L1).
class PlaygroundApp extends StatefulWidget {
  const PlaygroundApp({required this.appduct, super.key});

  final Appduct appduct;

  @override
  State<PlaygroundApp> createState() => _PlaygroundAppState();
}

class _PlaygroundAppState extends State<PlaygroundApp> {
  final _counter = PlaygroundCounter();
  late final void Function() _unregister;

  late final GoRouter _router = GoRouter(
    routes: [
      ShellRoute(
        builder: (context, state, child) => _Shell(child: child),
        routes: [
          GoRoute(
            path: '/',
            builder: (context, state) => _ToolsScreen(counter: _counter),
          ),
          GoRoute(
            path: '/status',
            builder: (context, state) => _StatusScreen(appduct: widget.appduct),
          ),
        ],
      ),
    ],
  );

  @override
  void initState() {
    super.initState();
    _unregister = registerPlaygroundTools(widget.appduct, _counter);
  }

  @override
  void dispose() {
    _unregister();
    _router.dispose();
    _counter.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => MaterialApp.router(
    title: 'Appduct Playground',
    theme: ThemeData(colorSchemeSeed: Colors.indigo),
    routerConfig: _router,
  );
}

class _Shell extends StatelessWidget {
  const _Shell({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    final onStatus = GoRouterState.of(context).uri.path == '/status';
    return Scaffold(
      appBar: AppBar(title: const Text('Appduct')),
      body: child,
      bottomNavigationBar: NavigationBar(
        selectedIndex: onStatus ? 1 : 0,
        onDestinationSelected: (i) => context.go(i == 0 ? '/' : '/status'),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.build), label: 'Tools'),
          NavigationDestination(icon: Icon(Icons.wifi), label: 'Status'),
        ],
      ),
    );
  }
}

class _ToolsScreen extends StatelessWidget {
  const _ToolsScreen({required this.counter});

  final PlaygroundCounter counter;

  @override
  Widget build(BuildContext context) => ListView(
    padding: const EdgeInsets.all(16),
    children: [
      Text('Quick start', style: Theme.of(context).textTheme.labelLarge),
      const SelectableText(
        'appduct sessions link --open ios-sim\n'
        'appduct tools ls\n'
        'appduct tools call sum --input \'{"a":2,"b":3}\'',
        style: TextStyle(fontFamily: 'monospace'),
      ),
      const SizedBox(height: 16),
      ListenableBuilder(
        listenable: counter,
        builder: (context, _) => Text(
          'Calls counted: ${counter.count}',
          style: Theme.of(context).textTheme.titleMedium,
        ),
      ),
      const SizedBox(height: 16),
      Text('Registered tools', style: Theme.of(context).textTheme.labelLarge),
      for (final name in playgroundToolNames)
        ListTile(dense: true, title: Text(name)),
    ],
  );
}

class _StatusScreen extends StatelessWidget {
  const _StatusScreen({required this.appduct});

  final Appduct appduct;

  @override
  Widget build(BuildContext context) => ListView(
    padding: const EdgeInsets.all(16),
    children: [
      ValueListenableBuilder(
        valueListenable: appduct.state,
        builder: (context, state, _) =>
            Text('Session: ${state.name}', key: const Key('session-state')),
      ),
      const SizedBox(height: 16),
      FilledButton(
        onPressed: () => appduct.postEvent('playground_ping', {
          'at': DateTime.now().millisecondsSinceEpoch,
        }),
        child: const Text('Send playground_ping'),
      ),
    ],
  );
}
