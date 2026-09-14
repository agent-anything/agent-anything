import type { ReactNode } from "react";
import { Splitter } from "antd";
import { useInspectionViewState } from "../navigation/InspectionViewState.js";

export function CanvasSplit({view, canvas, details}: {view: string; canvas: ReactNode; details: ReactNode}) {
  const [ratio, setRatio] = useInspectionViewState(`canvas-split:${view}`, 65);
  return <Splitter orientation="vertical" className="canvas-split" onResize={sizes => {
    const total = sizes[0]! + sizes[1]!;
    if (total > 0) setRatio(sizes[0]! / total * 100);
  }} onDraggerDoubleClick={() => setRatio(65)}>
    <Splitter.Panel size={`${ratio}%`} min={260}>{canvas}</Splitter.Panel>
    <Splitter.Panel min={130}><div className="canvas-support">{details}</div></Splitter.Panel>
  </Splitter>;
}
