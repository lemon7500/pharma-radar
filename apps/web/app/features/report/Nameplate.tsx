const PERIOD = {daily:"研究日报",weekly:"研究周报",monthly:"研究月报",archive:"研究简报档案"};
export function Nameplate({which,className=""}:{which:keyof typeof PERIOD;className?:string}) {
  return <span className={`report-nameplate ${className}`}><strong className="brand-font">Pharma Radar</strong><span>{PERIOD[which]}</span></span>;
}
