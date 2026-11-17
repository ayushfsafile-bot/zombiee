import { useEffect, useRef } from 'react';
import { OutbreakGameEngine } from './game/engine';

export default function App() {
  const mountRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container =
      mountRef.current || document.getElementById('game-canvas-container');
    if (!container) return;

    const engine = new OutbreakGameEngine(container);
    return () => {
      engine.dispose();
    };
  }, []);

  return <div ref={mountRef} className="w-full h-full" />;
}
