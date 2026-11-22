process.on('SIGTERM', () => process.exit(2));
console.log('Fixture setup exits nonzero on stop');
setInterval(() => {}, 1000);
