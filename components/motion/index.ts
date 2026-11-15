/**
 * FIREWATCH motion primitives — single import point.
 *
 *   import { AnimatedNumber, RevealSection, PageTransition } from "@/components/motion";
 *
 * CSS lives in ./motion.css and is imported by each component, so a component
 * used on its own is never unstyled. See MOTION_DESIGN_SYSTEM.md for the
 * layout/globals wiring and the reduced-motion contract.
 */

export { PageTransition } from "./PageTransition";
export { RevealSection } from "./RevealSection";
export { FadeIn } from "./FadeIn";
export { AnimatedNumber } from "./AnimatedNumber";
export { MotionButton } from "./MotionButton";
export { SmoothPanel } from "./SmoothPanel";
export { LoadingIndicator } from "./LoadingIndicator";
export { MotionRoot } from "./MotionRoot";
export { useChartMotion, useSeriesMotion } from "@/lib/motion";
export type { ChartMotion } from "@/lib/motion";
