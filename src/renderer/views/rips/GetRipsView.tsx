// Get Rips: download side of the SiIvaGunner section (highquality.rip albums, SGFR, YouTube playlist).

import { Empty } from '../../components/ui'

export function GetRipsView(_props: { tab?: 'albums' | 'sgfr' | 'youtube' }) {
  return (
    <div className="view">
      <Empty icon="download" title="Get Rips">
        <span>Rip album, SGFR and YouTube downloads are not set up in this build yet.</span>
      </Empty>
    </div>
  )
}
