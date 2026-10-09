import 'package:appduct/appduct.dart';
import 'package:flutter/material.dart';

import 'playground_app.dart';

void main() {
  // Before runApp: the binding has to see an Appduct link before the router reads it as a route.
  final appduct = Appduct.ensureInitialized();
  runApp(PlaygroundApp(appduct: appduct));
}
