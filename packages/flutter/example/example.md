# Example

Register a tool when the app starts. Run `appduct sessions link --open ios-sim` (or `--open android`)
with the app running in debug mode, then `appduct tools call seed_cart --input '{"items":3}'`.

```dart
import 'package:appduct/appduct.dart';
import 'package:flutter/material.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  Appduct.ensureInitialized();

  Appduct.instance.registerTool(
    'seed_cart',
    description: 'Fill the cart with test items.',
    inputSchema: {
      'type': 'object',
      'properties': {
        'items': {'type': 'number'},
      },
      'required': ['items'],
    },
    handler: (args, context) => {'added': (args['items'] as num).toInt()},
  );

  runApp(const MaterialApp(home: Scaffold(body: Center(child: Text('Shop')))));
}
```
