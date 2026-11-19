import { useRef, useState } from "react";
import { Animated, type ViewProps } from "react-native";
import { springs } from "./motion";
import { MagnifyArea } from "./native";
import { pinchGesture, type PinchMotion } from "./pinch";

export const PINCH_SPRING = { ...springs.snappy, overshootClamping: true, restDisplacementThreshold: 0.001, restSpeedThreshold: 0.01, useNativeDriver: true } as const;

export function pinchSettle(values: { value: Animated.Value; to: number }[]) {
  Animated.parallel(values.map(({ value, to }) => Animated.spring(value, { toValue: to, ...PINCH_SPRING }))).start();
}

export function PinchArea({ motion, enabled = true, passesThrough = false, ...props }: ViewProps & { motion: PinchMotion; enabled?: boolean; passesThrough?: boolean }) {
  const latest = useRef(motion);
  latest.current = motion;
  const [step] = useState(pinchGesture);
  return <MagnifyArea enabled={enabled} passesThrough={passesThrough} onMagnify={({ phase, magnification }) => step(latest.current, phase, magnification)} {...props} />;
}
