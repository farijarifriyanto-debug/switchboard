const os = require('node:os');
const { execFile } = require('node:child_process');

function detectNvidia() {
  return new Promise(resolve => {
    execFile('nvidia-smi', ['--query-gpu=name,memory.total,driver_version','--format=csv,noheader,nounits'], {timeout:5000, windowsHide:true}, (err, stdout) => {
      if (err) return resolve([]);
      const gpus = stdout.trim().split(/\r?\n/).filter(Boolean).map(line => {
        const [name, memoryMb, driver] = line.split(',').map(s => s.trim());
        return { name, memoryGb: +(Number(memoryMb)/1024).toFixed(1), driver };
      });
      resolve(gpus);
    });
  });
}

async function detectHardware() {
  const cpus = os.cpus();
  return {
    platform: process.platform,
    release: os.release(),
    arch: os.arch(),
    cpu: cpus[0]?.model || 'Unknown CPU',
    logicalCores: cpus.length,
    ramGb: +(os.totalmem()/1024**3).toFixed(1),
    freeRamGb: +(os.freemem()/1024**3).toFixed(1),
    nvidia: await detectNvidia()
  };
}

module.exports = { detectHardware };
