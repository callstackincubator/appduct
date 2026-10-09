import 'package:appduct/src/core/core.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('reads the wall clock in unix milliseconds', () {
    final before = DateTime.now().millisecondsSinceEpoch;
    final now = SystemClock().now();
    expect(
      now,
      inInclusiveRange(before, DateTime.now().millisecondsSinceEpoch),
    );
  });

  test('runs a timeout once its delay has passed', () async {
    var ran = 0;
    SystemClock().setTimeout(() => ran++, 10);

    expect(ran, 0);
    await Future<void>.delayed(const Duration(milliseconds: 60));
    expect(ran, 1);
  });

  test('does not run a timeout that was cleared', () async {
    final clock = SystemClock();
    var ran = 0;
    clock.clearTimeout(clock.setTimeout(() => ran++, 10));

    await Future<void>.delayed(const Duration(milliseconds: 60));
    expect(ran, 0);
  });
}
