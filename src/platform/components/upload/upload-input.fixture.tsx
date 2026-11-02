import { toast } from 'sonner';

import { UploadInput } from './upload-input';
const Default = () => {
  return (
    <UploadInput
      uploadRoute="baseImage"
      onSuccess={(file) => console.log('uploaded file', file)}
      onError={() => toast.error('Cannot upload in Cosmos')}
    />
  );
};

const WithDocument = () => {
  return (
    <UploadInput
      uploadRoute="baseImage"
      defaultValue={{ name: 'document.txt' }}
      onSuccess={(file) => console.log('uploaded file', file)}
      onError={() => toast.error('Cannot upload in Cosmos')}
    />
  );
};

const WithImage = () => {
  return (
    <UploadInput
      uploadRoute="baseImage"
      defaultValue={{
        name: 'cover.jpg',
        url: 'https://picsum.photos/seed/cosmos/200/200',
      }}
      onSuccess={(file) => console.log('uploaded file', file)}
      onError={() => toast.error('Cannot upload in Cosmos')}
    />
  );
};

const WithAcceptFilter = () => {
  return (
    <UploadInput
      uploadRoute="baseImage"
      inputProps={{
        accept: 'image/png,image/jpeg,image/gif',
      }}
      placeholder="Drop an image here, or click to browse"
      onSuccess={(file) => console.log('uploaded file', file)}
      onError={() => toast.error('Cannot upload in Cosmos')}
    />
  );
};

const CustomPlaceholder = () => {
  return (
    <UploadInput
      uploadRoute="baseImage"
      placeholder="Upload your document..."
      onSuccess={(file) => console.log('uploaded file', file)}
      onError={() => toast.error('Cannot upload in Cosmos')}
    />
  );
};

const Sizes = () => {
  return (
    <div className="flex flex-col gap-4">
      <UploadInput
        size="sm"
        uploadRoute="baseImage"
        onSuccess={(file) => console.log('uploaded file', file)}
        onError={() => toast.error('Cannot upload in Cosmos')}
      />
      <UploadInput
        uploadRoute="baseImage"
        onSuccess={(file) => console.log('uploaded file', file)}
        onError={() => toast.error('Cannot upload in Cosmos')}
      />
      <UploadInput
        size="lg"
        uploadRoute="baseImage"
        onSuccess={(file) => console.log('uploaded file', file)}
        onError={() => toast.error('Cannot upload in Cosmos')}
      />
    </div>
  );
};

const Disabled = () => {
  return (
    <UploadInput
      disabled
      uploadRoute="baseImage"
      onSuccess={(file) => console.log('uploaded file', file)}
      onError={() => toast.error('Cannot upload in Cosmos')}
    />
  );
};

export default {
  Default,
  WithDocument,
  WithImage,
  WithAcceptFilter,
  CustomPlaceholder,
  Sizes,
  Disabled,
};
