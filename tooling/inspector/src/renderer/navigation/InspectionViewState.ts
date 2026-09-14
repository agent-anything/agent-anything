import { useEffect, useState, type Dispatch, type SetStateAction } from "react";

// Ephemeral widget state only. Recorded bodies and authority never enter this map.
const views = new Map<string, unknown>();
export function readInspectionViewState<T>(key: string, initial: T): T {
  return views.has(key) ? views.get(key) as T : initial;
}
export function rememberInspectionViewState<T>(key: string, value: T): void {
  views.delete(key);
  views.set(key,value);
  while(views.size>64) views.delete(views.keys().next().value!);
}
export function useInspectionViewState<T>(key: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const [state,setState]=useState(()=>({key,value:readInspectionViewState(key,initial)}));
  const value=state.key===key ? state.value : readInspectionViewState(key,initial);
  useEffect(()=>{setState({key,value:readInspectionViewState(key,initial)});},[key]);
  const update: Dispatch<SetStateAction<T>> = next => {
    const current=readInspectionViewState(key,value);
    const resolved=typeof next === "function" ? (next as (previous:T)=>T)(current) : next;
    rememberInspectionViewState(key,resolved);
    setState({key,value:resolved});
  };
  return [value,update];
}
